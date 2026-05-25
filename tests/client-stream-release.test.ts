import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import {
  ConcurrencyBucket,
  _resetProcessBucketForTests,
  getProcessBucket,
} from "../src/rate-limit/index.js";

const okChat = JSON.stringify({ choices: [{ message: { content: "ok" } }] });

function clientWith(fetchFn: typeof fetch, bucket: ConcurrencyBucket): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: "sk-test",
    fetch: fetchFn,
    concurrencyBucket: bucket,
    retry: { maxAttempts: 1 },
  });
}

async function drain<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("DeepSeekClient releases concurrency tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetProcessBucketForTests();
  });

  it("releases token on stream !resp.ok", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(
      vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      bucket,
    );

    await expect(drain(client.stream({ model: "deepseek-v4-pro", messages: [] }))).rejects.toThrow(
      /DeepSeek 500/,
    );

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token on stream ok with missing body", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(
      vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      bucket,
    );

    await expect(drain(client.stream({ model: "deepseek-v4-pro", messages: [] }))).rejects.toThrow(
      /DeepSeek 200/,
    );

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token on chat response JSON parse error", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(
      vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
      bucket,
    );

    await expect(client.chat({ model: "deepseek-v4-pro", messages: [] })).rejects.toThrow();

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token on stream reader.read() throw mid-stream", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          return;
        }
        throw new Error("reader exploded");
      },
    });
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(
      vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      bucket,
    );

    await expect(drain(client.stream({ model: "deepseek-v4-pro", messages: [] }))).rejects.toThrow(
      /reader exploded/,
    );

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token on stream aborted after streaming started", async () => {
    const encoder = new TextEncoder();
    const ctrl = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          return;
        }
        return new Promise<void>((_resolve, reject) => {
          seenSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(fetchFn, bucket);
    const stream = client.stream({ model: "deepseek-v4-pro", messages: [], signal: ctrl.signal });

    const first = await stream.next();
    expect(first.value?.contentDelta).toBe("a");
    const second = stream.next();
    ctrl.abort(new DOMException("Aborted", "AbortError"));

    await expect(second).rejects.toThrow(/Aborted/);
    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token when aborted after acquire but before fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctrl = new AbortController();
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const fetchFn = vi.fn(
      async () => new Response(okChat, { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchFn,
      concurrencyBucket: bucket,
      rateLimit: { rpm: 1 },
      retry: { maxAttempts: 1 },
    });

    await client.chat({ model: "deepseek-v4-pro", messages: [] });
    const second = client.chat({ model: "deepseek-v4-pro", messages: [], signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort(new DOMException("Aborted", "AbortError"));

    await expect(second).rejects.toThrow(/Aborted/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token when aborted during fetch", async () => {
    const ctrl = new AbortController();
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      resolveFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;
    const client = clientWith(fetchFn, bucket);

    const pending = client.chat({ model: "deepseek-v4-pro", messages: [], signal: ctrl.signal });
    await fetchStarted;
    ctrl.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("does not double release when a token release is called twice", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const token = await bucket.acquire("deepseek-v4-pro");

    token.release();
    token.release();

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("releases token after successful chat", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const client = clientWith(
      vi.fn(async () => new Response(okChat, { status: 200 })) as unknown as typeof fetch,
      bucket,
    );

    await client.chat({ model: "deepseek-v4-pro", messages: [] });

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("retries chat after local acquire timeout", async () => {
    vi.useFakeTimers();
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { pro: 1 } },
      env: { REASONIX_QUEUE_GIVEUP_MS: "100", REASONIX_QUEUE_HINT_MS: "100000" },
    });
    const holder = await bucket.acquire("deepseek-v4-pro");
    const fetchFn = vi.fn(
      async () => new Response(okChat, { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchFn,
      concurrencyBucket: bucket,
      retry: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    const promise = client.chat({ model: "deepseek-v4-pro", messages: [] });
    await vi.advanceTimersByTimeAsync(100);
    holder.release();
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toMatchObject({ content: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ inUse: 0, queued: 0 });
  });

  it("initializes the default process bucket from rateLimit concurrency config", () => {
    new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn() as unknown as typeof fetch,
      rateLimit: { concurrency: { pro: 1 } },
    });

    expect(getProcessBucket().stats("deepseek-v4-pro").initialCap).toBe(1);
  });
});

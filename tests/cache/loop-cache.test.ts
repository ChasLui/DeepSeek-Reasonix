import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../../src/client.js";
import { parseSource } from "../../src/code-query/parser.js";
import { CacheFirstLoop } from "../../src/loop.js";
import { ImmutablePrefix } from "../../src/memory/runtime.js";

describe("CacheFirstLoop cache ownership", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "REASONIX_CACHE_BREAK_DIFF");
    vi.restoreAllMocks();
  });

  it("invalidates loop-owned file, parse, and web-fetch caches on log compaction", async () => {
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: vi.fn() as unknown as typeof fetch }),
      prefix: new ImmutablePrefix({ system: "test" }),
    });
    loop.fileCache.set("/tmp/a.ts", { mtimeMs: 1, size: 5 }, Buffer.from("alpha"), "sha", "utf8");
    loop.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      title: "A",
      text: "alpha",
      truncated: false,
    });
    const parsed = await parseSource("/tmp/a.ts", "function alpha() {}\n");
    loop.parseCache.set(
      { absPath: "/tmp/a.ts", mtimeMs: 1, size: 20, shaPrefix: "old" },
      parsed!.tree,
    );
    parsed!.tree.delete();

    expect(loop.fileCache.stats().entries).toBe(1);
    expect(loop.parseCache.stats().entries).toBe(1);
    expect(loop.webFetchCache.stats().entries).toBe(1);
    loop.log.compactInPlace([]);

    expect(loop.fileCache.stats().entries).toBe(0);
    expect(loop.parseCache.stats().entries).toBe(0);
    expect(loop.webFetchCache.stats().entries).toBe(0);
  });

  it("keeps cache instances isolated across loops", () => {
    const a = makeLoop();
    const b = makeLoop();
    const stat = { mtimeMs: 1, size: 5 };

    a.fileCache.set("/tmp/a.ts", stat, Buffer.from("alpha"), "a", "utf8");
    b.fileCache.set("/tmp/a.ts", stat, Buffer.from("bravo"), "b", "utf8");
    a.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      text: "alpha",
      truncated: false,
    });
    b.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      text: "bravo",
      truncated: false,
    });

    expect(a.fileCache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("alpha");
    expect(b.fileCache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("bravo");
    expect(a.webFetchCache.get("https://example.com/a", 100)?.text).toBe("alpha");
    expect(b.webFetchCache.get("https://example.com/a", 100)?.text).toBe("bravo");
  });

  it("keeps prompt-cache monitors isolated across loops", async () => {
    process.env.REASONIX_CACHE_BREAK_DIFF = "0";
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const a = makeLoop([usageResponse(10000, 100), usageResponse(5000, 5100)]);
    const b = makeLoop([usageResponse(10000, 100)]);

    await a.run("first");
    await a.run("second");
    await b.run("first");

    expect(a.cacheMonitor.stats()).toMatchObject({ breaks: 1, hitTokens: 15000 });
    expect(b.cacheMonitor.stats()).toMatchObject({ breaks: 0, hitTokens: 10000 });
    expect(a.cacheMonitor).not.toBe(b.cacheMonitor);
  });
});

function makeLoop(responses: FakeResponseShape[] = [usageResponse(0, 100)]): CacheFirstLoop {
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch(responses) }),
    prefix: new ImmutablePrefix({ system: "test" }),
    stream: false,
  });
}

interface FakeResponseShape {
  content?: string;
  usage?: Record<string, number>;
}

function usageResponse(hit: number, miss: number): FakeResponseShape {
  return {
    content: "ok",
    usage: {
      prompt_tokens: hit + miss,
      completion_tokens: 1,
      total_tokens: hit + miss + 1,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
    },
  };
}

function fakeFetch(responses: FakeResponseShape[]): typeof fetch {
  let i = 0;
  return vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        _echo_messages: body.messages,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: resp.content ?? "ok" },
            finish_reason: "stop",
          },
        ],
        usage: resp.usage,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

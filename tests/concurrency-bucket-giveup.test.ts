import { describe, expect, it, vi } from "vitest";
import { ConcurrencyBucket, RateLimitTimeoutError } from "../src/rate-limit/index.js";

describe("ConcurrencyBucket queue giveup", () => {
  it("times out queued acquisition after the default 60s", async () => {
    vi.useFakeTimers();
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const holder = await bucket.acquire("deepseek-v4-pro");
    const pending = bucket.acquire("deepseek-v4-pro");
    const rejected = expect(pending).rejects.toBeInstanceOf(RateLimitTimeoutError);

    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ inUse: 1, queued: 0 });
    holder.release();
    vi.useRealTimers();
  });

  it("honors REASONIX_QUEUE_GIVEUP_MS override", async () => {
    vi.useFakeTimers();
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { pro: 1 } },
      env: { REASONIX_QUEUE_GIVEUP_MS: "1000" },
    });
    const holder = await bucket.acquire("deepseek-v4-pro");
    const pending = bucket.acquire("deepseek-v4-pro");
    const rejected = expect(pending).rejects.toMatchObject({ waitMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    await rejected;
    holder.release();
    vi.useRealTimers();
  });
});

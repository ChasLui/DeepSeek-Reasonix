import { describe, expect, it, vi } from "vitest";
import { ConcurrencyBucket, type RateLimitEmitterEvent } from "../src/rate-limit/index.js";

describe("rate-limit emitter", () => {
  it("emits queued only after hint threshold and acquired when a queued token starts", async () => {
    vi.useFakeTimers();
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { pro: 1 } },
      env: { REASONIX_QUEUE_HINT_MS: "2000", REASONIX_QUEUE_GIVEUP_MS: "10000" },
    });
    const events: RateLimitEmitterEvent[] = [];
    const offQueued = bucket.events.on("rate-limit.queued", (event) => events.push(event));
    const offAcquired = bucket.events.on("rate-limit.acquired", (event) => events.push(event));

    const holder = await bucket.acquire("deepseek-v4-pro");
    const pending = bucket.acquire("deepseek-v4-pro");
    await vi.advanceTimersByTimeAsync(1900);
    expect(events.filter((event) => event.type === "rate-limit.queued")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(events).toContainEqual({
      type: "rate-limit.queued",
      model: "deepseek-v4-pro",
      depth: 1,
      estimatedWaitMs: expect.any(Number),
    });

    holder.release();
    const queued = await pending;
    expect(events).toContainEqual({
      type: "rate-limit.acquired",
      model: "deepseek-v4-pro",
      queuedMs: expect.any(Number),
    });
    queued.release();
    offQueued();
    offAcquired();
    vi.useRealTimers();
  });

  it("notifies multiple subscribers", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const seenA: RateLimitEmitterEvent[] = [];
    const seenB: RateLimitEmitterEvent[] = [];
    bucket.events.on("rate-limit.acquired", (event) => seenA.push(event));
    bucket.events.on("rate-limit.acquired", (event) => seenB.push(event));

    const token = await bucket.acquire("deepseek-v4-pro");
    token.release();

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });
});

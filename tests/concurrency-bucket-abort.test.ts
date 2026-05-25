import { describe, expect, it } from "vitest";
import { ConcurrencyBucket } from "../src/rate-limit/index.js";

describe("ConcurrencyBucket abort and token invariants", () => {
  it("removes an aborted queued acquire without leaking a token", async () => {
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { pro: 1 } },
      env: { REASONIX_QUEUE_HINT_MS: "100000", REASONIX_QUEUE_GIVEUP_MS: "100000" },
    });
    const holder = await bucket.acquire("deepseek-v4-pro");
    const ctrl = new AbortController();
    const pending = bucket.acquire("deepseek-v4-pro", ctrl.signal);

    ctrl.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ inUse: 1, queued: 0 });
    holder.release();
    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("release is idempotent regardless of state transitions", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const token = await bucket.acquire("deepseek-v4-pro");
    token.transitionTo("fetching");
    token.transitionTo("streaming");

    token.release();
    token.release();

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("transitioning to released frees the token", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const token = await bucket.acquire("deepseek-v4-pro");
    token.transitionTo("fetching");

    token.transitionTo("released");
    token.release();

    expect(bucket.stats("deepseek-v4-pro").inUse).toBe(0);
  });

  it("rejects invalid token transitions", async () => {
    const bucket = new ConcurrencyBucket({ rateLimit: { concurrency: { pro: 1 } } });
    const token = await bucket.acquire("deepseek-v4-pro");

    expect(() => token.transitionTo("streaming")).toThrow(/invalid token transition/);
    token.release();
  });
});

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { ConcurrencyBucket, type ConcurrencyToken } from "../src/rate-limit/index.js";

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

describe("ConcurrencyBucket latency isolation", () => {
  it("keeps pro acquisition independent while flash work is queued", async () => {
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { flash: 1, pro: 1 } },
      env: { REASONIX_QUEUE_HINT_MS: "100000", REASONIX_QUEUE_GIVEUP_MS: "100000" },
    });
    const flashHolder = await bucket.acquire("deepseek-v4-flash");
    const queuedFlash: Array<Promise<ConcurrencyToken>> = [];
    for (let i = 0; i < 8; i++) queuedFlash.push(bucket.acquire("deepseek-v4-flash"));

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const pro = await bucket.acquire("deepseek-v4-pro");
      samples.push(performance.now() - started);
      pro.release();
    }

    expect(p95(samples)).toBeLessThan(200);
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ inUse: 0, queued: 0 });
    expect(bucket.stats("deepseek-v4-flash").queued).toBe(8);

    flashHolder.release();
    for (const pending of queuedFlash) {
      const token = await pending;
      token.release();
    }
  });
});

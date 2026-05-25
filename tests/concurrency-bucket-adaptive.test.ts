import { describe, expect, it } from "vitest";
import { ConcurrencyBucket } from "../src/rate-limit/index.js";

describe("ConcurrencyBucket adaptive caps", () => {
  it("degrades once inside the 5s throttle window and restores by time only", () => {
    let now = 1000;
    const bucket = new ConcurrencyBucket({
      now: () => now,
      rateLimit: { concurrency: { pro: 16 } },
      env: {
        REASONIX_429_THROTTLE_WINDOW_MS: "5000",
        REASONIX_429_RESTORE_INTERVAL_MS: "60000",
      },
    });

    bucket.note429("deepseek-v4-pro");
    expect(bucket.stats("deepseek-v4-pro").cap).toBe(8);
    for (let i = 0; i < 4; i++) {
      now += 1000;
      bucket.note429("deepseek-v4-pro");
    }
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ cap: 8, recent429: 5 });

    now += 60_000;
    bucket.maybeRestore("deepseek-v4-pro");
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ cap: 12, inUse: 0 });
    now += 60_000;
    bucket.maybeRestore("deepseek-v4-pro");
    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({
      cap: 16,
      degradedAt: null,
    });
  });

  it("adaptive=false disables degrade and restore", () => {
    let now = 1000;
    const bucket = new ConcurrencyBucket({
      now: () => now,
      rateLimit: { concurrency: { pro: 16, adaptive: false } },
      env: { REASONIX_429_RESTORE_INTERVAL_MS: "60000" },
    });

    bucket.note429("deepseek-v4-pro");
    now += 60_000;
    bucket.maybeRestore("deepseek-v4-pro");

    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({
      cap: 16,
      recent429: 1,
      degradedAt: null,
      adaptive: false,
    });
  });

  it("env adaptive flag takes precedence over config", () => {
    const bucket = new ConcurrencyBucket({
      rateLimit: { concurrency: { pro: 16, adaptive: true } },
      env: { REASONIX_CONCURRENCY_ADAPTIVE: "0" },
    });

    bucket.note429("deepseek-v4-pro");

    expect(bucket.stats("deepseek-v4-pro")).toMatchObject({ cap: 16, adaptive: false });
  });
});

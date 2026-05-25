import { describe, expect, it } from "vitest";
import {
  type CacheBreakReport,
  PromptCacheMonitor,
} from "../../src/observability/prompt-cache-monitor.js";

describe("PromptCacheMonitor legacy break categories", () => {
  it("keeps ttl-1h reports readable through stats and JSON round-trip", () => {
    const monitor = new PromptCacheMonitor();
    const legacyReport: CacheBreakReport = {
      timestamp: Date.now(),
      callCount: 2,
      prevHitTokens: 10_000,
      hitTokens: 1000,
      dropTokens: 9000,
      reason: "possible 1h TTL expiry (prompt unchanged)",
      reasonCategory: "ttl-1h",
    };

    (monitor as unknown as { breakHistory: CacheBreakReport[] }).breakHistory.push(legacyReport);

    expect(() => monitor.stats()).not.toThrow();
    expect(monitor.stats()).toMatchObject({
      breaks: 1,
      recentBreakCategories: ["ttl-1h"],
      lastBreakReason: legacyReport.reason,
    });
    expect(JSON.parse(JSON.stringify(monitor.getReport()))[0].reasonCategory).toBe("ttl-1h");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCockpitCacheForTests,
  computeCockpit,
  computeWarm,
} from "../src/server/api/cockpit.js";
import type { DashboardContext } from "../src/server/context.js";
import { getDb, resetDb } from "../src/storage/db.js";
import { appendUsageRow } from "../src/storage/usage-repo.js";
import type { UsageRecord } from "../src/telemetry/usage.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

function ctxOnly(): DashboardContext {
  return { configPath: "", mode: "attached" };
}

// Append a usage row to the SQLite singleton (cockpit reads via readUsageLog()).
function seed(opts: {
  ts: number;
  prompt?: number;
  completion?: number;
  hit?: number;
  miss?: number;
  cost?: number;
  model?: string;
}): void {
  const rec: UsageRecord = {
    ts: opts.ts,
    session: null,
    model: opts.model ?? "deepseek-v4-flash",
    promptTokens: opts.prompt ?? 1000,
    completionTokens: opts.completion ?? 200,
    cacheHitTokens: opts.hit ?? 800,
    cacheMissTokens: opts.miss ?? 200,
    costUsd: opts.cost ?? 0.001,
    claudeEquivUsd: 0.01,
  };
  appendUsageRow(getDb(), rec);
}

describe("computeWarm", () => {
  let dir: string;
  let sessionsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rx-cockpit-"));
    sessionsDir = join(dir, "sessions");
    getDb(join(dir, "reasonix.db"));
    _resetCockpitCacheForTests();
  });

  afterEach(() => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nulls when the usage log is empty", () => {
    const out = computeWarm(NOW, sessionsDir);
    expect(out.tokens7d).toBeNull();
    expect(out.cacheHit7d).toBeNull();
    expect(out.costTrend14d).toBeNull();
  });

  it("rolls up tokens7d as prompt + completion across the trailing week", () => {
    seed({ ts: NOW - 1 * DAY, prompt: 10_000, completion: 2_000 });
    seed({ ts: NOW - 5 * DAY, prompt: 30_000, completion: 8_000 });
    seed({ ts: NOW - 8 * DAY, prompt: 99_999, completion: 99_999 });
    const out = computeWarm(NOW, sessionsDir);
    expect(out.tokens7d?.total).toBe(50_000);
  });

  it("computes tokens7d deltaPct vs the prior 7-day window", () => {
    seed({ ts: NOW - 1 * DAY, prompt: 10_000, completion: 0 });
    seed({ ts: NOW - 9 * DAY, prompt: 5_000, completion: 0 });
    const out = computeWarm(NOW, sessionsDir);
    expect(out.tokens7d?.deltaPct).toBeCloseTo(100, 5);
  });

  it("returns null deltaPct when the prior week has no records", () => {
    seed({ ts: NOW - 1 * DAY });
    const out = computeWarm(NOW, sessionsDir);
    expect(out.tokens7d?.deltaPct).toBeNull();
  });

  it("derives cacheHit7d ratio from the trailing-week bucket", () => {
    seed({ ts: NOW - 1 * DAY, hit: 900, miss: 100 });
    seed({ ts: NOW - 2 * DAY, hit: 100, miss: 900 });
    const out = computeWarm(NOW, sessionsDir);
    expect(out.cacheHit7d?.ratio).toBeCloseTo(0.5, 5);
  });

  it("sparkline has exactly `days` entries even when most days are empty", () => {
    seed({ ts: NOW - 2 * DAY, cost: 0.05 });
    const out = computeWarm(NOW, sessionsDir);
    expect(out.costTrend14d).toHaveLength(14);
    const total = (out.costTrend14d ?? []).reduce((s, d) => s + d.usd, 0);
    expect(total).toBeCloseTo(0.05, 5);
  });

  it("sparkline drops records older than the window", () => {
    seed({ ts: NOW - 30 * DAY, cost: 99 });
    const out = computeWarm(NOW, sessionsDir);
    const total = (out.costTrend14d ?? []).reduce((s, d) => s + d.usd, 0);
    expect(total).toBe(0);
  });
});

describe("computeCockpit", () => {
  let dir: string;
  let sessionsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rx-cockpit-"));
    sessionsDir = join(dir, "sessions");
    getDb(join(dir, "reasonix.db"));
    _resetCockpitCacheForTests();
  });

  afterEach(() => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(extra: Partial<DashboardContext> = {}): DashboardContext {
    return { ...ctxOnly(), sessionsDir, ...extra };
  }

  it("returns null cockpit fields when ctx has no loop, no stats, no log", () => {
    const out = computeCockpit(ctx(), NOW);
    expect(out.balance).toBeNull();
    expect(out.currentSession).toBeNull();
    expect(out.tokens7d).toBeNull();
    expect(out.toolCalls24h).toBeNull();
    expect(out.recentPlans).toBeNull();
    expect(out.toolActivity).toBeNull();
  });

  it("surfaces balance from getStats", () => {
    const out = computeCockpit(
      ctx({
        getStats: () => ({
          turns: 0,
          totalCostUsd: 0,
          lastTurnCostUsd: 0,
          totalInputCostUsd: 0,
          totalOutputCostUsd: 0,
          cacheHitRatio: 0,
          lastPromptTokens: 0,
          contextCapTokens: 1_000_000,
          balance: [{ currency: "CNY", total_balance: "48.20" }],
        }),
      }),
      NOW,
    );
    expect(out.balance).toEqual({ currency: "CNY", total: "48.20" });
  });

  it("warm fields are reused from cache within the TTL window", () => {
    seed({ ts: NOW - 1 * DAY, prompt: 10_000 });
    const first = computeCockpit(ctx(), NOW);
    seed({ ts: NOW - 1 * DAY, prompt: 999_999 });
    const second = computeCockpit(ctx(), NOW + 5_000);
    expect(second.tokens7d?.total).toBe(first.tokens7d?.total);
  });

  it("warm fields refresh once the TTL has elapsed", () => {
    seed({ ts: NOW - 1 * DAY, prompt: 10_000 });
    const first = computeCockpit(ctx(), NOW);
    seed({ ts: NOW - 1 * DAY, prompt: 999_999 });
    const second = computeCockpit(ctx(), NOW + 60_000);
    expect(second.tokens7d?.total).not.toBe(first.tokens7d?.total);
    expect(second.tokens7d?.total).toBeGreaterThan(first.tokens7d?.total ?? 0);
  });
});

import { describe, expect, it } from "vitest";
import {
  checkBudgetWindow,
  checkBudgetWindows,
  periodWindowDays,
} from "../../src/budget/window.js";
import { type UsageRecord, aggregateUsage } from "../../src/telemetry/usage.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function rec(tsOffsetMs: number, costUsd: number, workspace?: string): UsageRecord {
  return {
    ts: NOW + tsOffsetMs,
    session: null,
    model: "deepseek-v4-flash",
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd,
    claudeEquivUsd: 0,
    ...(workspace ? { workspace } : {}),
  };
}

describe("checkBudgetWindow", () => {
  it("daily reads the 24h bucket", () => {
    const agg = aggregateUsage([rec(-1000, 0.3), rec(-2 * DAY, 99)], {
      now: NOW,
    });
    const s = checkBudgetWindow(agg, { period: "daily", capUsd: 1 });
    // The 2-day-old $99 record is outside the daily window — not counted.
    expect(s.spentUsd).toBeCloseTo(0.3);
    expect(s.state).toBe("ok");
    expect(s.remainingUsd).toBeCloseTo(0.7);
  });

  it("weekly reads the 7d bucket", () => {
    const agg = aggregateUsage([rec(-3 * DAY, 0.5), rec(-10 * DAY, 5)], {
      now: NOW,
    });
    const s = checkBudgetWindow(agg, { period: "weekly", capUsd: 2 });
    expect(s.spentUsd).toBeCloseTo(0.5); // 10-day-old is outside the week
  });

  it("monthly reads the 30d bucket", () => {
    const agg = aggregateUsage([rec(-20 * DAY, 4), rec(-40 * DAY, 50)], {
      now: NOW,
    });
    const s = checkBudgetWindow(agg, { period: "monthly", capUsd: 10 });
    expect(s.spentUsd).toBeCloseTo(4); // 40-day-old is outside the month
  });

  it("warns at 80%, exhausts at 100%", () => {
    const warnAgg = aggregateUsage([rec(-1000, 0.85)], { now: NOW });
    expect(checkBudgetWindow(warnAgg, { period: "daily", capUsd: 1 }).state).toBe("warn");

    const exhaustedAgg = aggregateUsage([rec(-1000, 1.0)], { now: NOW });
    expect(checkBudgetWindow(exhaustedAgg, { period: "daily", capUsd: 1 }).state).toBe("exhausted");

    const okAgg = aggregateUsage([rec(-1000, 0.5)], { now: NOW });
    expect(checkBudgetWindow(okAgg, { period: "daily", capUsd: 1 }).state).toBe("ok");
  });

  it("cap <= 0 disables the guardrail (never warns/exhausts)", () => {
    const agg = aggregateUsage([rec(-1000, 999)], { now: NOW });
    expect(checkBudgetWindow(agg, { period: "daily", capUsd: 0 }).state).toBe("ok");
    expect(checkBudgetWindow(agg, { period: "daily", capUsd: -5 }).state).toBe("ok");
  });

  it("empty log → zero spend, ok", () => {
    const agg = aggregateUsage([], { now: NOW });
    const s = checkBudgetWindow(agg, { period: "monthly", capUsd: 10 });
    expect(s.spentUsd).toBe(0);
    expect(s.state).toBe("ok");
    expect(s.remainingUsd).toBe(10);
  });

  it("defaults the scope to global when the window omits it", () => {
    const agg = aggregateUsage([rec(-1000, 0.1)], { now: NOW });
    expect(checkBudgetWindow(agg, { period: "daily", capUsd: 1 }).scope).toBe("global");
  });
});

describe("checkBudgetWindows (scope-aware)", () => {
  const records = [
    rec(-1000, 0.9, "/ws/a"),
    rec(-1000, 5, "/ws/b"),
    rec(-1000, 0.2), // legacy row, no workspace
  ];

  it("global counts all spend; workspace counts only the active workspace", () => {
    const statuses = checkBudgetWindows(
      records,
      [
        { period: "daily", capUsd: 1, scope: "global" },
        { period: "daily", capUsd: 1, scope: "workspace" },
      ],
      { now: NOW, workspace: "/ws/a" },
    );
    const global = statuses.find((s) => s.scope === "global");
    const ws = statuses.find((s) => s.scope === "workspace");
    expect(global?.spentUsd).toBeCloseTo(6.1); // 0.9 + 5 + 0.2
    expect(global?.state).toBe("exhausted");
    expect(ws?.spentUsd).toBeCloseTo(0.9); // /ws/a only
    expect(ws?.state).toBe("warn");
  });

  it("a different workspace sees only its own spend", () => {
    const statuses = checkBudgetWindows(
      records,
      [{ period: "daily", capUsd: 1, scope: "workspace" }],
      { now: NOW, workspace: "/ws/b" },
    );
    expect(statuses[0]?.spentUsd).toBeCloseTo(5);
    expect(statuses[0]?.state).toBe("exhausted");
  });

  it("a workspace window with no workspace context is inert (ok, zero spend)", () => {
    const statuses = checkBudgetWindows(
      records,
      [{ period: "daily", capUsd: 1, scope: "workspace" }],
      { now: NOW },
    );
    expect(statuses[0]?.spentUsd).toBe(0);
    expect(statuses[0]?.state).toBe("ok");
  });
});

describe("periodWindowDays", () => {
  it("maps periods to rolling-window lengths", () => {
    expect(periodWindowDays("daily")).toBe(1);
    expect(periodWindowDays("weekly")).toBe(7);
    expect(periodWindowDays("monthly")).toBe(30);
  });
});

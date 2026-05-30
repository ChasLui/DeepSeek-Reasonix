/** Cross-session rolling budget gate — reads the shared usage aggregate from
 * SQLite, blocks the next turn post-hoc, never mutates the store. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetWindow } from "../src/budget/window.js";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { getDb, resetDb } from "../src/storage/db.js";
import { appendUsageRow } from "../src/storage/usage-repo.js";
import type { UsageRecord } from "../src/telemetry/usage.js";

const DAY = 24 * 60 * 60 * 1000;

function fakeFetch(): { fn: typeof fetch; calls: () => number } {
  const f = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "ok",
              reasoning_content: null,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fn: f as unknown as typeof fetch, calls: () => f.mock.calls.length };
}

function makeClient(fetchFn: typeof fetch): DeepSeekClient {
  return new DeepSeekClient({ apiKey: "sk-test", fetch: fetchFn });
}

function seedUsage(
  records: Array<{ tsOffset: number; costUsd: number; workspace?: string }>,
): void {
  const now = Date.now();
  const db = getDb();
  for (const r of records) {
    const rec: UsageRecord = {
      ts: now + r.tsOffset,
      session: "seeded",
      model: "deepseek-v4-flash",
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      costUsd: r.costUsd,
      claudeEquivUsd: 0,
      ...(r.workspace ? { workspace: r.workspace } : {}),
    };
    appendUsageRow(db, rec);
  }
}

const DAILY_1USD: BudgetWindow = { period: "daily", capUsd: 1 };

describe("CacheFirstLoop window budget gate", () => {
  let dir: string;

  // The loop's budget gate reads the SQLite singleton via readUsageSince();
  // open it against a fresh tmp db per test for isolation.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "budget-gate-"));
    getDb(join(dir, "reasonix.db"));
  });
  afterEach(() => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks the next turn once the window's spend reaches the cap", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 1.5 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD],
    });

    const events: { role: string; error?: string }[] = [];
    for await (const ev of loop.step("q")) events.push({ role: ev.role, error: ev.error });

    expect(events).toHaveLength(1);
    expect(events[0]?.role).toBe("error");
    expect(events[0]?.error).toMatch(/rolling budget exhausted/);
    // Pillar 1: refusal happened before any model call or log mutation.
    expect(fetcher.calls()).toBe(0);
    expect(loop.log.length).toBe(0);
    expect(loop.currentTurn).toBe(0);
    expect(loop.stats.turns).toHaveLength(0);
  });

  it("warns once at 80% but lets the turn run", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 0.85 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD],
    });

    const roles: string[] = [];
    const warnings: string[] = [];
    for await (const ev of loop.step("q")) {
      roles.push(ev.role);
      if (ev.role === "warning") warnings.push(ev.content);
    }
    expect(warnings.filter((w) => /rolling budget 80% used/.test(w))).toHaveLength(1);
    expect(roles).toContain("assistant_final");
    expect(fetcher.calls()).toBe(1);
  });

  it("does not exist below 80% — turn runs clean", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 0.1 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD],
    });

    const roles: string[] = [];
    for await (const ev of loop.step("q")) roles.push(ev.role);
    expect(roles).not.toContain("error");
    expect(roles.filter((r) => r === "warning")).toHaveLength(0);
    expect(roles).toContain("assistant_final");
  });

  it("rolling window: spend older than the window does not count (auto-recovers)", async () => {
    // $9 spent 2 days ago — outside the daily window, so it must NOT block.
    seedUsage([{ tsOffset: -2 * DAY, costUsd: 9 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD],
    });

    const roles: string[] = [];
    for await (const ev of loop.step("q")) roles.push(ev.role);
    expect(roles).not.toContain("error");
    expect(roles).toContain("assistant_final");
    expect(fetcher.calls()).toBe(1);
  });

  it("no budgetWindow → byte-identical to baseline (no gate, no events)", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 9999 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      // no budgetWindows — even huge prior spend is ignored
    });
    expect(loop.budgetWindows).toHaveLength(0);

    const roles: string[] = [];
    for await (const ev of loop.step("q")) roles.push(ev.role);
    expect(roles).not.toContain("error");
    expect(roles.filter((r) => r === "warning")).toHaveLength(0);
    expect(roles).toContain("assistant_final");
  });

  it("window cap and per-session cap coexist; whichever trips first blocks", async () => {
    // Window is fine (no prior spend) but the per-session cap is already over.
    seedUsage([]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetUsd: 1.0,
      budgetWindows: [DAILY_1USD],
    });
    (
      loop.stats.turns as unknown as Array<{
        cost: number;
        model: string;
        usage: unknown;
      }>
    ).push({
      cost: 1.5,
      model: loop.model,
      usage: {},
    });

    const events: { role: string; error?: string }[] = [];
    for await (const ev of loop.step("q")) events.push({ role: ev.role, error: ev.error });
    // Per-session cap is checked first, so its message wins.
    expect(events[0]?.role).toBe("error");
    expect(events[0]?.error).toMatch(/budget exhausted/);
    expect(fetcher.calls()).toBe(0);
  });

  it("setBudgetWindows mid-session takes effect on the next turn's gate", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 1.5 }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      // starts with no window → first turn runs despite the seeded $1.5
    });
    expect(loop.budgetWindowStatuses()).toHaveLength(0);

    const roles1: string[] = [];
    for await (const ev of loop.step("q1")) roles1.push(ev.role);
    expect(roles1).toContain("assistant_final");

    // Arm the rolling cap live; the seeded $1.5 now exceeds daily $1.
    loop.setBudgetWindows([{ period: "daily", capUsd: 1 }]);
    expect(loop.budgetWindowStatuses()[0]?.state).toBe("exhausted");
    const callsBefore = fetcher.calls();

    const events2: { role: string; error?: string }[] = [];
    for await (const ev of loop.step("q2")) events2.push({ role: ev.role, error: ev.error });
    expect(events2).toHaveLength(1);
    expect(events2[0]?.error).toMatch(/rolling budget exhausted/);
    expect(fetcher.calls()).toBe(callsBefore); // no new model call
  });

  const WS_A = "/ws/a";
  const WS_B = "/ws/b";
  const DAILY_1USD_WS: BudgetWindow = {
    period: "daily",
    capUsd: 1,
    scope: "workspace",
  };

  it("a workspace window blocks on the loop's own workspace spend", async () => {
    seedUsage([
      { tsOffset: -1000, costUsd: 1.5, workspace: WS_A },
      { tsOffset: -1000, costUsd: 99, workspace: WS_B }, // other workspace — must not count
    ]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD_WS],
      workspace: WS_A,
    });

    const events: { role: string; error?: string }[] = [];
    for await (const ev of loop.step("q")) events.push({ role: ev.role, error: ev.error });
    expect(events).toHaveLength(1);
    expect(events[0]?.role).toBe("error");
    expect(events[0]?.error).toMatch(/rolling budget exhausted/);
    expect(fetcher.calls()).toBe(0);
  });

  it("a different workspace is not blocked by another workspace's spend", async () => {
    // All the spend belongs to WS_A; a loop scoped to WS_B sees none of it.
    seedUsage([{ tsOffset: -1000, costUsd: 99, workspace: WS_A }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD_WS],
      workspace: WS_B,
    });

    const roles: string[] = [];
    for await (const ev of loop.step("q")) roles.push(ev.role);
    expect(roles).not.toContain("error");
    expect(roles).toContain("assistant_final");
    expect(fetcher.calls()).toBe(1);
  });

  it("a workspace window in a loop with no workspace context is inert", async () => {
    seedUsage([{ tsOffset: -1000, costUsd: 99, workspace: WS_A }]);
    const fetcher = fakeFetch();
    const loop = new CacheFirstLoop({
      client: makeClient(fetcher.fn),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      budgetWindows: [DAILY_1USD_WS],
      // no workspace — workspace-scoped windows can't attribute spend, so never block
    });
    expect(loop.budgetWindowStatuses()[0]?.state).toBe("ok");

    const roles: string[] = [];
    for await (const ev of loop.step("q")) roles.push(ev.role);
    expect(roles).toContain("assistant_final");
    expect(fetcher.calls()).toBe(1);
  });
});

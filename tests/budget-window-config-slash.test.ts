/** Rolling-budget config writer round-trip + the `/budget window` slash, both scopes. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlers } from "../src/cli/ui/slash/handlers/model.js";
import { DeepSeekClient } from "../src/client.js";
import { loadBudgetWindows, resolveBudgetWindows, saveBudgetWindow } from "../src/config.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

describe("budget window config writer", () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "budget-cfg-"));
    cfgPath = join(dir, "config.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("round-trips one period through save → load (default global scope)", () => {
    expect(loadBudgetWindows(cfgPath)).toEqual([]);
    saveBudgetWindow("weekly", 12.5, "global", cfgPath);
    expect(loadBudgetWindows(cfgPath)).toEqual([
      { period: "weekly", capUsd: 12.5, scope: "global" },
    ]);
  });

  it("holds several periods at once, in daily→weekly→monthly order", () => {
    saveBudgetWindow("monthly", 50, "global", cfgPath);
    saveBudgetWindow("daily", 5, "global", cfgPath);
    expect(loadBudgetWindows(cfgPath)).toEqual([
      { period: "daily", capUsd: 5, scope: "global" },
      { period: "monthly", capUsd: 50, scope: "global" },
    ]);
  });

  it("a workspace window coexists with a global window of the same period", () => {
    saveBudgetWindow("daily", 5, "global", cfgPath);
    saveBudgetWindow("daily", 2, "workspace", cfgPath);
    // global windows sort before workspace windows.
    expect(loadBudgetWindows(cfgPath)).toEqual([
      { period: "daily", capUsd: 5, scope: "global" },
      { period: "daily", capUsd: 2, scope: "workspace" },
    ]);
  });

  it("clears just one (scope, period), leaving the others", () => {
    saveBudgetWindow("daily", 5, "global", cfgPath);
    saveBudgetWindow("daily", 2, "workspace", cfgPath);
    saveBudgetWindow("monthly", 50, "global", cfgPath);
    saveBudgetWindow("daily", null, "global", cfgPath);
    expect(loadBudgetWindows(cfgPath)).toEqual([
      { period: "monthly", capUsd: 50, scope: "global" },
      { period: "daily", capUsd: 2, scope: "workspace" },
    ]);
  });

  it("a zero/negative cap clears the (scope, period)", () => {
    saveBudgetWindow("monthly", 30, "global", cfgPath);
    saveBudgetWindow("monthly", 0, "global", cfgPath);
    expect(loadBudgetWindows(cfgPath)).toEqual([]);
  });

  it("env (period+cap) overrides config; config-only periods coexist", () => {
    saveBudgetWindow("monthly", 50, "global", cfgPath);
    vi.stubEnv("REASONIX_BUDGET_PERIOD", "monthly");
    vi.stubEnv("REASONIX_BUDGET_CAP", "10");
    // env monthly:10 overrides config monthly:50
    expect(resolveBudgetWindows(cfgPath)).toEqual([
      { period: "monthly", capUsd: 10, scope: "global" },
    ]);
    // switch env to a different period — config monthly:50 stays alongside
    vi.stubEnv("REASONIX_BUDGET_PERIOD", "daily");
    expect(resolveBudgetWindows(cfgPath)).toEqual([
      { period: "daily", capUsd: 10, scope: "global" },
      { period: "monthly", capUsd: 50, scope: "global" },
    ]);
  });

  it("REASONIX_BUDGET_SCOPE=workspace makes the env window workspace-scoped", () => {
    vi.stubEnv("REASONIX_BUDGET_PERIOD", "daily");
    vi.stubEnv("REASONIX_BUDGET_CAP", "3");
    vi.stubEnv("REASONIX_BUDGET_SCOPE", "workspace");
    expect(resolveBudgetWindows(cfgPath)).toEqual([
      { period: "daily", capUsd: 3, scope: "workspace" },
    ]);
  });
});

function fakeClient(): DeepSeekClient {
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
  return new DeepSeekClient({
    apiKey: "sk-test",
    fetch: f as unknown as typeof fetch,
  });
}

describe("/budget window slash", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "budget-slash-"));
    // defaultConfigPath() resolves via homedir() → $HOME on POSIX, so this
    // isolates saveBudgetWindow's default-path write away from the real config.
    vi.stubEnv("HOME", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeLoop(): CacheFirstLoop {
    return new CacheFirstLoop({
      client: fakeClient(),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      usageLogPath: join(dir, "usage.jsonl"),
    });
  }

  it("status with no window set reports none", () => {
    const loop = makeLoop();
    const res = handlers.budget(["window"], loop, {} as never);
    expect(res.info).toMatch(/no rolling budget/i);
  });

  it("set persists to config and updates the live loop", () => {
    const loop = makeLoop();
    expect(loop.budgetWindows).toHaveLength(0);
    const res = handlers.budget(["window", "daily", "5"], loop, {} as never);
    expect(res.info).toMatch(/rolling budget/i);
    // Live loop updated without restart.
    expect(loop.budgetWindows).toEqual([{ period: "daily", capUsd: 5, scope: "global" }]);
    // Persisted to the (HOME-isolated) config.
    expect(loadBudgetWindows(join(dir, ".reasonix", "config.json"))).toEqual([
      { period: "daily", capUsd: 5, scope: "global" },
    ]);
  });

  it("a workspace window stacks alongside a global one via the slash scope token", () => {
    const loop = makeLoop();
    handlers.budget(["window", "daily", "5"], loop, {} as never);
    handlers.budget(["window", "workspace", "daily", "2"], loop, {} as never);
    expect(loop.budgetWindows).toEqual([
      { period: "daily", capUsd: 5, scope: "global" },
      { period: "daily", capUsd: 2, scope: "workspace" },
    ]);
  });

  it("a second period stacks alongside the first", () => {
    const loop = makeLoop();
    handlers.budget(["window", "daily", "5"], loop, {} as never);
    handlers.budget(["window", "monthly", "50"], loop, {} as never);
    expect(loop.budgetWindows).toEqual([
      { period: "daily", capUsd: 5, scope: "global" },
      { period: "monthly", capUsd: 50, scope: "global" },
    ]);
  });

  it("off clears every window (both scopes) from config and the loop", () => {
    const loop = makeLoop();
    handlers.budget(["window", "daily", "5"], loop, {} as never);
    handlers.budget(["window", "workspace", "monthly", "50"], loop, {} as never);
    const res = handlers.budget(["window", "off"], loop, {} as never);
    expect(res.info).toMatch(/off/i);
    expect(loop.budgetWindows).toHaveLength(0);
    expect(loadBudgetWindows(join(dir, ".reasonix", "config.json"))).toEqual([]);
  });

  it("`workspace <period> off` clears just that workspace window", () => {
    const loop = makeLoop();
    handlers.budget(["window", "daily", "5"], loop, {} as never);
    handlers.budget(["window", "workspace", "daily", "2"], loop, {} as never);
    handlers.budget(["window", "workspace", "daily", "off"], loop, {} as never);
    expect(loop.budgetWindows).toEqual([{ period: "daily", capUsd: 5, scope: "global" }]);
  });

  it("rejects a bad period with a usage hint and does not persist", () => {
    const loop = makeLoop();
    const res = handlers.budget(["window", "fortnightly", "5"], loop, {} as never);
    expect(res.info).toMatch(/usage:/i);
    expect(loop.budgetWindows).toHaveLength(0);
  });

  it("$-prefixed cap is accepted", () => {
    const loop = makeLoop();
    handlers.budget(["window", "monthly", "$50"], loop, {} as never);
    expect(loop.budgetWindows).toEqual([{ period: "monthly", capUsd: 50, scope: "global" }]);
  });
});

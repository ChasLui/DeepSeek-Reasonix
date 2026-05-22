/** Cross-session rolling budget guardrail — pure logic over the existing
 * usage.jsonl aggregate. Post-hoc; never mutates the log. */

import { type UsageAggregate, type UsageRecord, aggregateUsage } from "../telemetry/usage.js";

export type BudgetPeriod = "daily" | "weekly" | "monthly";

/** `global` gates total spend across every workspace; `workspace` gates only the spend attributed to the active workspace (via `UsageRecord.workspace`). Absent ⟹ `global`. */
export type BudgetScope = "global" | "workspace";

export interface BudgetWindow {
  period: BudgetPeriod;
  /** USD cap for the rolling window. <= 0 disables the guardrail. */
  capUsd: number;
  /** Absent ⟹ `global` (back-compat with single-scope configs). */
  scope?: BudgetScope;
}

export interface BudgetWindowState {
  state: "ok" | "warn" | "exhausted";
  period: BudgetPeriod;
  scope: BudgetScope;
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
}

/** A window's scope with the `global` default applied. */
export function budgetWindowScope(w: BudgetWindow): BudgetScope {
  return w.scope ?? "global";
}

/** Map a budget period to the `aggregateUsage` bucket label it gates on. A
 * switch (not a Record) keeps this off the prototype-pollution lint gate. */
function bucketLabelForPeriod(p: BudgetPeriod): string {
  switch (p) {
    case "daily":
      return "today";
    case "weekly":
      return "week";
    case "monthly":
      return "month";
  }
}

/** Number of days the period's rolling window spans — drives the lookback read. */
export function periodWindowDays(p: BudgetPeriod): number {
  switch (p) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
  }
}

/** Pure: read the matching rolling bucket's spend out of an existing aggregate
 * and classify against the cap. `warn` at 80%, `exhausted` at 100%. */
export function checkBudgetWindow(agg: UsageAggregate, w: BudgetWindow): BudgetWindowState {
  const label = bucketLabelForPeriod(w.period);
  const bucket = agg.buckets.find((b) => b.label === label);
  const spentUsd = bucket?.costUsd ?? 0;
  const capUsd = w.capUsd;
  const remainingUsd = Math.max(0, capUsd - spentUsd);
  let state: BudgetWindowState["state"] = "ok";
  if (capUsd > 0) {
    if (spentUsd >= capUsd) state = "exhausted";
    else if (spentUsd >= capUsd * 0.8) state = "warn";
  }
  return {
    state,
    period: w.period,
    scope: budgetWindowScope(w),
    spentUsd,
    capUsd,
    remainingUsd,
  };
}

/** Classify every window over one record set: global windows count all spend,
 * workspace windows count only `opts.workspace`. A workspace window with no
 * workspace context is inert (`ok`, zero spend). Shared by the loop gate, doctor, stats. */
export function checkBudgetWindows(
  records: UsageRecord[],
  windows: readonly BudgetWindow[],
  opts: { now?: number; workspace?: string } = {},
): BudgetWindowState[] {
  if (windows.length === 0) return [];
  const aggGlobal = aggregateUsage(records, { now: opts.now });
  const hasWorkspace = windows.some((w) => budgetWindowScope(w) === "workspace");
  const aggWorkspace =
    hasWorkspace && opts.workspace !== undefined
      ? aggregateUsage(records, { now: opts.now, workspace: opts.workspace })
      : null;
  return windows.map((w) => {
    if (budgetWindowScope(w) === "workspace") {
      if (aggWorkspace === null) {
        return {
          state: "ok",
          period: w.period,
          scope: "workspace",
          spentUsd: 0,
          capUsd: w.capUsd,
          remainingUsd: Math.max(0, w.capUsd),
        };
      }
      return checkBudgetWindow(aggWorkspace, w);
    }
    return checkBudgetWindow(aggGlobal, w);
  });
}

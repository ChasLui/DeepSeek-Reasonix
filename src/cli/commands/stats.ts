/** `reasonix stats [path]` — path arg switches to per-transcript mode; default is the cross-session dashboard. */

import { existsSync, readFileSync } from "node:fs";
import { checkBudgetWindows } from "../../budget/window.js";
import { resolveBudgetWindows } from "../../config.js";
import { t } from "../../i18n/index.js";
import { countRecentObservationEvents } from "../../memory/observation.js";
import type { PromptCacheStats } from "../../observability/prompt-cache-monitor.js";
import {
  type UsageAggregate,
  type UsageBucket,
  aggregateUsage,
  bucketCacheHitRatio,
  bucketSavingsFraction,
  defaultUsageLogPath,
  formatLogSize,
  readUsageLog,
} from "../../telemetry/usage.js";

export interface StatsOptions {
  /** Optional transcript path. Absent → dashboard mode. */
  transcript?: string;
  /** Override usage log location (tests). */
  logPath?: string;
  /** Inject a fixed timestamp (tests) so rolling windows are deterministic. */
  now?: number;
}

export interface DashboardCacheStats {
  fileCache: {
    hits: number;
    misses: number;
    evictions: number;
    sizeBytes: number;
    entries: number;
  };
  parseCache: {
    hits: number;
    misses: number;
    evictions: number;
    entries: number;
  };
  webFetchCache: {
    hits: number;
    misses: number;
    evictions: number;
    entries: number;
    skipped: number;
  };
}

export interface DashboardMemoryStats {
  observations24h: number;
  hybridLlmTokens: number;
}

export function statsCommand(opts: StatsOptions): void {
  if (opts.transcript) {
    transcriptSummary(opts.transcript);
    return;
  }
  dashboard(opts);
}

function transcriptSummary(path: string): void {
  if (!existsSync(path)) {
    console.error(`no such transcript: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  let assistantTurns = 0;
  let toolCalls = 0;
  let lastTurn = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.role === "assistant_final") assistantTurns++;
      if (rec.role === "tool") toolCalls++;
      if (typeof rec.turn === "number") lastTurn = Math.max(lastTurn, rec.turn);
    } catch {
      /* skip */
    }
  }
  console.log(`transcript:       ${path}`);
  console.log(`assistant turns:  ${assistantTurns}`);
  console.log(`tool invocations: ${toolCalls}`);
  console.log(`last turn index:  ${lastTurn}`);
}

function dashboard(opts: StatsOptions): void {
  const path = opts.logPath ?? defaultUsageLogPath();
  const records = readUsageLog(path);
  const memoryStats = {
    observations24h: countRecentObservationEvents(),
    hybridLlmTokens: 0,
  };
  if (records.length === 0) {
    console.log("no usage data yet.");
    console.log(renderMemoryRecallLine(memoryStats));
    console.log("");
    console.log(`  ${path}`);
    console.log("");
    console.log(t("stats.usageHint"));
    console.log(t("stats.usageDetail"));
    return;
  }

  const agg = aggregateUsage(records, { now: opts.now });
  console.log(renderDashboard(agg, path, undefined, undefined, memoryStats));
  const windows = resolveBudgetWindows();
  if (windows.length > 0) {
    console.log("");
    const statuses = checkBudgetWindows(records, windows, {
      now: opts.now,
      workspace: process.cwd(),
    });
    for (const s of statuses) {
      const flag = s.state === "ok" ? "" : ` (${s.state})`;
      console.log(
        `rolling budget:    ${s.scope} ${s.period} $${s.spentUsd.toFixed(4)} / $${s.capUsd.toFixed(2)} this window${flag}`,
      );
    }
  }
}

/** Pure renderer — pulled out so tests can assert on the string directly. */
export function renderDashboard(
  agg: UsageAggregate,
  logPath: string,
  cacheStats?: DashboardCacheStats,
  promptCacheStats?: PromptCacheStats,
  memoryStats?: DashboardMemoryStats,
): string {
  const lines: string[] = [];
  const size = formatLogSize(logPath);
  lines.push(`Reasonix usage — ${logPath}${size ? ` (${size})` : ""}`);
  lines.push(renderPromptCacheLine(agg, promptCacheStats));
  lines.push(renderToolCacheLine(cacheStats));
  lines.push(renderMemoryRecallLine(memoryStats));
  lines.push("");
  lines.push(header());
  lines.push(divider());
  for (const b of agg.buckets) {
    lines.push(bucketRow(b));
  }
  lines.push("");

  // Model + session breakdown — both trim to top 3 so a user with 20
  // sessions doesn't drown the table.
  if (agg.byModel.length > 0) {
    const totalTurns = agg.buckets[agg.buckets.length - 1]?.turns ?? 0;
    const top = agg.byModel[0];
    if (top && totalTurns > 0) {
      const pct = ((top.turns / totalTurns) * 100).toFixed(0);
      lines.push(`most used model:   ${top.model} (${pct}% of turns)`);
    }
  }
  if (agg.bySession.length > 0) {
    const top = agg.bySession[0];
    if (top) lines.push(`top session:       ${top.session} (${top.turns} turns)`);
  }
  if (agg.firstSeen) {
    lines.push(`tracked since:     ${new Date(agg.firstSeen).toISOString().slice(0, 10)}`);
  }
  if (agg.subagents) {
    lines.push("");
    lines.push(renderSubagentSection(agg.subagents));
  }
  return lines.join("\n");
}

function renderMemoryRecallLine(stats?: DashboardMemoryStats): string {
  const hybridTokens = stats?.hybridLlmTokens ?? 0;
  const observations = stats?.observations24h ?? 0;
  return `memory recall:   hybrid llm tokens=${hybridTokens} · observations 24h=${observations}`;
}

function renderPromptCacheLine(agg: UsageAggregate, stats?: PromptCacheStats): string {
  if (stats && !stats.enabled) return "prompt-cache:   disabled";
  const all = agg.buckets[agg.buckets.length - 1];
  const ratio = all ? bucketCacheHitRatio(all) : 0;
  const breaks = stats?.breaks ?? 0;
  const last = stats?.lastBreakReason ? ` · last: ${stats.lastBreakReason}` : "";
  return `prompt-cache:   ${(ratio * 100).toFixed(1)}% hit · ${breaks} breaks${last}`;
}

function renderToolCacheLine(stats?: DashboardCacheStats): string {
  if (!stats) {
    const file = process.env.REASONIX_FILE_CACHE === "0" ? "off" : "on";
    const parse = process.env.REASONIX_PARSE_CACHE === "0" ? "off" : "on";
    const web = process.env.REASONIX_WEB_FETCH_CACHE === "0" ? "off" : "on";
    return `tool cache:      file=${file} parse=${parse} web-fetch=${web} (session-local hit rates are shown in /status)`;
  }
  const fileTotal = stats.fileCache.hits + stats.fileCache.misses;
  const parseTotal = stats.parseCache.hits + stats.parseCache.misses;
  const webTotal = stats.webFetchCache.hits + stats.webFetchCache.misses;
  const fileRate = fileTotal > 0 ? (stats.fileCache.hits / fileTotal) * 100 : 0;
  const parseRate = parseTotal > 0 ? (stats.parseCache.hits / parseTotal) * 100 : 0;
  const webRate = webTotal > 0 ? (stats.webFetchCache.hits / webTotal) * 100 : 0;
  return [
    `tool cache:      file ${fileRate.toFixed(1)}% (${stats.fileCache.hits}/${fileTotal})`,
    `parse ${parseRate.toFixed(1)}% (${stats.parseCache.hits}/${parseTotal})`,
    `web ${webRate.toFixed(1)}% (${stats.webFetchCache.hits}/${webTotal})`,
    `evict f=${stats.fileCache.evictions} p=${stats.parseCache.evictions} w=${stats.webFetchCache.evictions}`,
  ].join(" · ");
}

function renderSubagentSection(sub: NonNullable<UsageAggregate["subagents"]>): string {
  const lines: string[] = [];
  const seconds = (sub.totalDurationMs / 1000).toFixed(1);
  lines.push(
    `subagent activity: ${sub.total} run(s) · $${sub.costUsd.toFixed(6)} · ${seconds}s total`,
  );
  // Show at most 5 skills so the section never dwarfs the main table.
  const top = sub.bySkill.slice(0, 5);
  for (const s of top) {
    const sec = (s.durationMs / 1000).toFixed(1);
    lines.push(
      `  ${pad(s.skillName, 18)} ${pad(`${s.count}`, 4, "right")}  $${s.costUsd.toFixed(6)}  ${sec}s`,
    );
  }
  if (sub.bySkill.length > top.length) {
    lines.push(`  (+${sub.bySkill.length - top.length} more)`);
  }
  return lines.join("\n");
}

function header(): string {
  // Fixed column widths so alignment works in any TTY.
  // `cache saved` reports DeepSeek's hit-vs-miss USD diff; the existing
  // `saved` column is the % saved vs Claude-Sonnet equivalent.
  return [
    pad("", 10),
    pad("turns", 8, "right"),
    pad("reasoning", 10, "right"),
    pad("cache hit", 10, "right"),
    pad("cost (USD)", 14, "right"),
    pad("cache saved", 14, "right"),
    pad("vs Claude", 14, "right"),
    pad("saved", 10, "right"),
  ].join("  ");
}

function divider(): string {
  return "-".repeat(98);
}

function bucketRow(b: UsageBucket): string {
  const hit = bucketCacheHitRatio(b);
  const savings = bucketSavingsFraction(b);
  return [
    pad(b.label, 10),
    pad(b.turns.toString(), 8, "right"),
    pad(b.turns > 0 && b.reasoningTokens > 0 ? b.reasoningTokens.toString() : "—", 10, "right"),
    pad(b.turns > 0 ? `${(hit * 100).toFixed(1)}%` : "—", 10, "right"),
    pad(b.turns > 0 ? `$${b.costUsd.toFixed(6)}` : "—", 14, "right"),
    pad(
      b.turns > 0 && b.cacheSavingsUsd > 0 ? `$${b.cacheSavingsUsd.toFixed(4)}` : "—",
      14,
      "right",
    ),
    pad(b.turns > 0 ? `$${b.claudeEquivUsd.toFixed(4)}` : "—", 14, "right"),
    pad(b.turns > 0 && savings > 0 ? `${(savings * 100).toFixed(1)}%` : "—", 10, "right"),
  ].join("  ");
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? `${fill}${s}` : `${s}${fill}`;
}

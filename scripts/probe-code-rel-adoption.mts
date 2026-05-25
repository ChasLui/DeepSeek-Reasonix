#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionsDir } from "../src/memory/session.js";

type TargetToolName = "find_references" | "detect_changes" | "impact";

const TARGET_TOOL_NAMES: readonly TargetToolName[] = [
  "find_references",
  "detect_changes",
  "impact",
];
const TARGET_TOOL_NAME_SET: ReadonlySet<string> = new Set(TARGET_TOOL_NAMES);
const DEFAULT_LIMIT = 30;
const DEFAULT_MIN_SESSIONS = 30;
const Z_95 = 1.96;

type SourceKind = "messages" | "events";
type Decision = "GO" | "CONDITIONAL" | "ABANDON" | "DATA_INSUFFICIENT";

export interface ProbeOptions {
  dir?: string;
  source: SourceKind;
  limit?: number;
  minSessions: number;
  includeSubagents: boolean;
}

export interface ProbeResult {
  source: SourceKind;
  dir: string;
  filesAvailable: number;
  filesScanned: number;
  usableSessionFiles: number;
  filesWithToolCalls: number;
  oldestUsableSessionMtime: string | null;
  newestUsableSessionMtime: string | null;
  usableWindowDays: number | null;
  parseErrors: number;
  skippedEmptyFiles: number;
  skippedUnparseableFiles: number;
  parseableJsonLines: number;
  totalToolCalls: number;
  targetToolCalls: number;
  targetCounts: Record<TargetToolName, number>;
  ratio: number;
  ci95: { low: number; high: number };
  decision: Decision;
}

interface SessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

interface CliOptions extends ProbeOptions {
  json: boolean;
  gate: boolean;
  help: boolean;
}

function usage(): string {
  return `Usage: npx tsx scripts/probe-code-rel-adoption.mts [options]

Options:
  --dir <path>             Session directory (default: REASONIX_SESSIONS_DIR or ~/.reasonix/sessions)
  --source <messages|events>
                           Parse assistant tool_calls or event-log tool.call records (default: messages)
  --limit <n>              Scan newest n files (default: ${DEFAULT_LIMIT})
  --all                    Scan all matching files
  --min-sessions <n>       Minimum files needed before GO/CONDITIONAL/ABANDON (default: ${DEFAULT_MIN_SESSIONS})
  --include-subagents      Include subagent-* session files
  --gate                   Exit non-zero unless the Slice 0 decision allows implementation
  --json                   Emit machine-readable JSON
  --help                   Show this help
`;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    source: "messages",
    limit: DEFAULT_LIMIT,
    minSessions: DEFAULT_MIN_SESSIONS,
    includeSubagents: false,
    json: false,
    gate: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--gate") {
      opts.gate = true;
    } else if (arg === "--include-subagents") {
      opts.includeSubagents = true;
    } else if (arg === "--all") {
      opts.limit = undefined;
    } else if (arg === "--dir") {
      opts.dir = requireValue(argv, ++i, "--dir");
    } else if (arg === "--source") {
      const source = requireValue(argv, ++i, "--source");
      if (source !== "messages" && source !== "events")
        throw new Error(`invalid --source: ${source}`);
      opts.source = source;
    } else if (arg === "--limit") {
      opts.limit = parsePositiveInteger(requireValue(argv, ++i, "--limit"), "--limit");
    } else if (arg === "--min-sessions") {
      opts.minSessions = parsePositiveInteger(
        requireValue(argv, ++i, "--min-sessions"),
        "--min-sessions",
      );
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function analyzeSessions(opts: ProbeOptions): ProbeResult {
  const dir = expandHome(opts.dir ?? defaultSessionsDir());
  const targetCounts = zeroTargetCounts();
  let parseErrors = 0;
  let skippedEmptyFiles = 0;
  let skippedUnparseableFiles = 0;
  let parseableJsonLines = 0;
  let usableSessionFiles = 0;
  let filesWithToolCalls = 0;
  let oldestUsableMtimeMs = Number.POSITIVE_INFINITY;
  let newestUsableMtimeMs = Number.NEGATIVE_INFINITY;
  let totalToolCalls = 0;
  let targetToolCalls = 0;

  const available = listSessionFiles(dir, opts.source, opts.includeSubagents);
  const selected = opts.limit ? available.slice(0, opts.limit) : available;

  for (const file of selected) {
    if (file.size === 0) {
      skippedEmptyFiles++;
      continue;
    }
    const analysis = analyzeJsonlText(readFileSync(file.path, "utf8"), opts.source);
    parseErrors += analysis.parseErrors;
    parseableJsonLines += analysis.parseableJsonLines;
    if (analysis.parseableJsonLines === 0) {
      skippedUnparseableFiles++;
      continue;
    }
    usableSessionFiles++;
    oldestUsableMtimeMs = Math.min(oldestUsableMtimeMs, file.mtimeMs);
    newestUsableMtimeMs = Math.max(newestUsableMtimeMs, file.mtimeMs);
    if (analysis.totalToolCalls > 0) filesWithToolCalls++;
    totalToolCalls += analysis.totalToolCalls;
    targetToolCalls += analysis.targetToolCalls;
    for (const name of TARGET_TOOL_NAMES) {
      targetCounts[name] += analysis.targetCounts[name];
    }
  }

  const ratio = totalToolCalls === 0 ? 0 : targetToolCalls / totalToolCalls;
  const hasUsableSessions = usableSessionFiles > 0;
  return {
    source: opts.source,
    dir,
    filesAvailable: available.length,
    filesScanned: selected.length,
    usableSessionFiles,
    filesWithToolCalls,
    oldestUsableSessionMtime: hasUsableSessions
      ? new Date(oldestUsableMtimeMs).toISOString()
      : null,
    newestUsableSessionMtime: hasUsableSessions
      ? new Date(newestUsableMtimeMs).toISOString()
      : null,
    usableWindowDays: hasUsableSessions
      ? (newestUsableMtimeMs - oldestUsableMtimeMs) / (24 * 60 * 60 * 1000)
      : null,
    parseErrors,
    skippedEmptyFiles,
    skippedUnparseableFiles,
    parseableJsonLines,
    totalToolCalls,
    targetToolCalls,
    targetCounts,
    ratio,
    ci95: wilsonInterval(targetToolCalls, totalToolCalls),
    decision: decideAdoption(usableSessionFiles, opts.minSessions, ratio),
  };
}

export function analyzeJsonlText(
  text: string,
  source: SourceKind,
): Omit<
  ProbeResult,
  | "source"
  | "dir"
  | "filesAvailable"
  | "filesScanned"
  | "usableSessionFiles"
  | "filesWithToolCalls"
  | "oldestUsableSessionMtime"
  | "newestUsableSessionMtime"
  | "usableWindowDays"
  | "skippedEmptyFiles"
  | "skippedUnparseableFiles"
  | "ratio"
  | "ci95"
  | "decision"
> {
  const targetCounts = zeroTargetCounts();
  let parseErrors = 0;
  let parseableJsonLines = 0;
  let totalToolCalls = 0;
  let targetToolCalls = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      parseableJsonLines++;
    } catch {
      parseErrors++;
      continue;
    }
    const names = source === "events" ? eventToolNames(parsed) : messageToolNames(parsed);
    for (const name of names) {
      totalToolCalls++;
      if (isTargetToolName(name)) {
        targetCounts[name]++;
        targetToolCalls++;
      }
    }
  }

  return { parseErrors, parseableJsonLines, totalToolCalls, targetToolCalls, targetCounts };
}

export function decideAdoption(filesScanned: number, minSessions: number, ratio: number): Decision {
  if (filesScanned < minSessions) return "DATA_INSUFFICIENT";
  if (ratio < 0.05) return "ABANDON";
  if (ratio < 0.2) return "CONDITIONAL";
  return "GO";
}

export function gateExitCode(decision: Decision): number {
  return decision === "GO" || decision === "CONDITIONAL" ? 0 : 2;
}

export function wilsonInterval(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const p = successes / total;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

function listSessionFiles(
  dir: string,
  source: SourceKind,
  includeSubagents: boolean,
): SessionFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((entry) => {
      if (!matchesSource(entry, source)) return [];
      if (!includeSubagents && entry.startsWith("subagent-")) return [];
      const path = join(dir, entry);
      const stat = statSync(path);
      if (!stat.isFile()) return [];
      return [{ path, size: stat.size, mtimeMs: stat.mtimeMs }];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || basename(a.path).localeCompare(basename(b.path)));
}

function matchesSource(entry: string, source: SourceKind): boolean {
  if (source === "events") return entry.endsWith(".events.jsonl");
  return entry.endsWith(".jsonl") && !entry.endsWith(".events.jsonl");
}

function messageToolNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const toolCalls = toolNamesFromCalls(value.tool_calls ?? value.toolCalls);
  if (toolCalls.length > 0) return toolCalls;
  return toolNamesFromContent(value.content);
}

function eventToolNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (value.type !== "tool.call") return [];
  return typeof value.name === "string" && value.name.length > 0 ? [value.name] : [];
}

function toolNamesFromCalls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = toolNameFromCall(item);
    if (name) names.push(name);
  }
  return names;
}

function toolNameFromCall(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.name === "string" && value.name.length > 0) return value.name;
  if (!isRecord(value.function)) return null;
  return typeof value.function.name === "string" && value.function.name.length > 0
    ? value.function.name
    : null;
}

function toolNamesFromContent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== "tool_use") continue;
    if (typeof item.name === "string" && item.name.length > 0) names.push(item.name);
  }
  return names;
}

function zeroTargetCounts(): Record<TargetToolName, number> {
  return {
    find_references: 0,
    detect_changes: 0,
    impact: 0,
  };
}

function isTargetToolName(name: string): name is TargetToolName {
  return TARGET_TOOL_NAME_SET.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSessionsDir(): string {
  return process.env.REASONIX_SESSIONS_DIR ?? sessionsDir();
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatHuman(result: ProbeResult): string {
  return [
    "code-rel adoption probe",
    `source: ${result.source}`,
    `dir: ${result.dir}`,
    `files: scanned ${result.filesScanned}/${result.filesAvailable} (usable: ${result.usableSessionFiles}, with tool calls: ${result.filesWithToolCalls}, empty skipped: ${result.skippedEmptyFiles}, unparseable skipped: ${result.skippedUnparseableFiles})`,
    `usable window: ${formatWindow(result)}`,
    `parseable json lines: ${result.parseableJsonLines}`,
    `tool calls: ${result.totalToolCalls}`,
    `target calls: ${result.targetToolCalls} (${formatPercent(result.ratio)})`,
    `target detail: find_references=${result.targetCounts.find_references}, detect_changes=${result.targetCounts.detect_changes}, impact=${result.targetCounts.impact}`,
    `95% CI: ${formatPercent(result.ci95.low)} - ${formatPercent(result.ci95.high)}`,
    `parse errors: ${result.parseErrors}`,
    `decision: ${result.decision}`,
  ].join("\n");
}

function formatWindow(result: ProbeResult): string {
  if (
    result.oldestUsableSessionMtime === null ||
    result.newestUsableSessionMtime === null ||
    result.usableWindowDays === null
  ) {
    return "n/a";
  }
  return `${result.oldestUsableSessionMtime} - ${result.newestUsableSessionMtime} (${result.usableWindowDays.toFixed(2)} days)`;
}

async function runCli(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  const result = analyzeSessions(opts);
  process.stdout.write(
    opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`,
  );
  if (opts.gate) process.exitCode = gateExitCode(result.decision);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

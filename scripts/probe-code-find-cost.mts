#!/usr/bin/env node
// Slice-0 instrument for Pillar-5 plan: measure how many find-class tool calls
// precede the first edit in real coding sessions (the "code-finding cost").

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionsDir } from "../src/memory/session.js";

// Tools that constitute "looking for code" before an edit.
const FIND_CLASS = new Set<string>([
  "read_file",
  "search_content",
  "search_files",
  "glob",
  "find_references",
  "detect_changes",
  "semantic_search",
  "list_directory",
  "directory_tree",
  "get_file_info",
]);

// Tools that mark the "first edit" boundary (a real coding action started).
const EDIT_CLASS = new Set<string>(["edit_file", "write_file"]);

interface CliOptions {
  dir?: string;
  limit?: number;
  json: boolean;
  help: boolean;
  includeSubagents: boolean;
}

interface SessionFile {
  path: string;
  mtimeMs: number;
}

interface SessionStat {
  file: string;
  toolCalls: number;
  hasEdit: boolean;
  findBeforeFirstEdit: number;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { json: false, help: false, includeSubagents: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--all") opts.limit = undefined;
    else if (arg === "--include-subagents") opts.includeSubagents = true;
    else if (arg === "--dir") opts.dir = argv[++i];
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toolNamesFromMessage(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (value.role !== "assistant") return [];
  const names: string[] = [];
  const calls = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      if (!isRecord(c)) continue;
      if (typeof c.name === "string" && c.name) names.push(c.name);
      else if (isRecord(c.function) && typeof c.function.name === "string" && c.function.name)
        names.push(c.function.name);
    }
  }
  return names;
}

function listSessionFiles(dir: string, includeSubagents: boolean): SessionFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((entry) => {
      if (!entry.endsWith(".jsonl") || entry.endsWith(".events.jsonl")) return [];
      if (!includeSubagents && entry.startsWith("subagent-")) return [];
      const path = join(dir, entry);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0) return [];
      return [{ path, mtimeMs: stat.mtimeMs }];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || basename(a.path).localeCompare(basename(b.path)));
}

function analyzeSession(text: string): SessionStat | null {
  const sequence: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const name of toolNamesFromMessage(parsed)) sequence.push(name);
  }
  if (sequence.length === 0) return null;
  const firstEditIdx = sequence.findIndex((n) => EDIT_CLASS.has(n));
  const upTo = firstEditIdx === -1 ? sequence.length : firstEditIdx;
  let findBefore = 0;
  for (let i = 0; i < upTo; i++) if (FIND_CLASS.has(sequence[i])) findBefore++;
  return {
    file: "",
    toolCalls: sequence.length,
    hasEdit: firstEditIdx !== -1,
    findBeforeFirstEdit: findBefore,
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function run(): void {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: pnpm exec tsx scripts/probe-code-find-cost.mts [--dir <path>] [--all] [--limit n] [--json]\n",
    );
    return;
  }
  const dir = resolve(
    opts.dir
      ? opts.dir.replace(/^~(?=$|\/)/, homedir())
      : (process.env.REASONIX_SESSIONS_DIR ?? sessionsDir()),
  );
  const files = listSessionFiles(dir, opts.includeSubagents);
  const selected = opts.limit ? files.slice(0, opts.limit) : files;

  const toolFreq = new Map<string, number>();
  const stats: SessionStat[] = [];
  let emptyOrUnparseable = 0;

  for (const f of selected) {
    const stat = analyzeSession(readFileSync(f.path, "utf8"));
    if (!stat) {
      emptyOrUnparseable++;
      continue;
    }
    stat.file = basename(f.path);
    stats.push(stat);
    for (const raw of readFileSync(f.path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        for (const n of toolNamesFromMessage(JSON.parse(line)))
          toolFreq.set(n, (toolFreq.get(n) ?? 0) + 1);
      } catch {
        /* skip */
      }
    }
  }

  const withEdit = stats.filter((s) => s.hasEdit);
  const findChains = withEdit.map((s) => s.findBeforeFirstEdit).sort((a, b) => a - b);
  const topTools = [...toolFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const summary = {
    dir,
    filesAvailable: files.length,
    filesScanned: selected.length,
    usableSessions: stats.length,
    emptyOrUnparseable,
    sessionsWithEdit: withEdit.length,
    findBeforeFirstEdit: {
      min: findChains[0] ?? 0,
      median: quantile(findChains, 0.5),
      p90: quantile(findChains, 0.9),
      max: findChains[findChains.length - 1] ?? 0,
      mean: findChains.length ? findChains.reduce((a, b) => a + b, 0) / findChains.length : 0,
    },
    sessionsWithFindChainGte: {
      "2": withEdit.filter((s) => s.findBeforeFirstEdit >= 2).length,
      "4": withEdit.filter((s) => s.findBeforeFirstEdit >= 4).length,
      "8": withEdit.filter((s) => s.findBeforeFirstEdit >= 8).length,
    },
    topToolNames: topTools.map(([name, count]) => ({ name, count })),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "code-find-cost probe",
      `dir: ${summary.dir}`,
      `files: scanned ${summary.filesScanned}/${summary.filesAvailable} (usable ${summary.usableSessions}, empty/unparseable ${summary.emptyOrUnparseable})`,
      `sessions with edit: ${summary.sessionsWithEdit}`,
      `find-class calls before first edit (with-edit sessions): min=${summary.findBeforeFirstEdit.min} median=${summary.findBeforeFirstEdit.median} p90=${summary.findBeforeFirstEdit.p90} max=${summary.findBeforeFirstEdit.max} mean=${summary.findBeforeFirstEdit.mean.toFixed(2)}`,
      `with-edit sessions whose find-chain >= 2: ${summary.sessionsWithFindChainGte["2"]}, >= 4: ${summary.sessionsWithFindChainGte["4"]}, >= 8: ${summary.sessionsWithFindChainGte["8"]}`,
      "top tool names:",
      ...topTools.map(([name, count]) => `  ${name}: ${count}`),
      "",
    ].join("\n"),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

/** Per-command output compactor: model gets a short structured view; raw is teed to disk for recovery. */

import { tokenizeCommand } from "../tools/shell/parse.js";

export interface CompactInput {
  /** Full command line as the user (or LLM) typed it. */
  cmd: string;
  /** Tokenized argv (post-quote-resolution); never empty for matched filters. */
  argv: readonly string[];
  /** Combined stdout+stderr after `runCommand` decoded it. */
  output: string;
  /** Null when the process was killed or never reported (e.g. timeout). */
  exitCode: number | null;
  /** True when the process was killed for exceeding its timeout — filters should generally bail back to raw. */
  timedOut: boolean;
}

export interface CompactResult {
  /** Compressed text shown to the model. Equal to `raw` when no filter matched or one failed. */
  compact: string;
  /** Untouched original output. Empty string when `output` itself was empty. */
  raw: string;
  /** Bytes saved (raw.length - compact.length). Negative values clamp to 0. */
  savedBytes: number;
  /** Filter id ("git-status", "vitest", …) or "passthrough" / "disabled" / "fallback". */
  filter: string;
}

export type CompactorFn = (input: CompactInput) => string | null;

export interface CompactorEntry {
  /** Stable id for telemetry and tests. */
  id: string;
  /** Coarse argv check — return true to claim this command. First true wins. */
  match: (argv: readonly string[], cmd: string) => boolean;
  /** Produce the compact view. Returning `null` is equivalent to passthrough. Throwing falls back to raw + records `fallback`. */
  filter: CompactorFn;
}

export interface CompactorRuntime {
  /** Hard kill switch. Set false to bypass the layer entirely (REASONIX_COMPACT=0). */
  enabled: boolean;
  /** argv[0] basenames to skip (e.g. ["git"] disables every git filter). Case-sensitive. */
  exclude: ReadonlySet<string>;
}

export interface CompactStatEntry {
  hits: number;
  savedBytes: number;
}

export const DEFAULT_RUNTIME: CompactorRuntime = {
  enabled: true,
  exclude: new Set<string>(),
};

/** Module-level registry. Tests can `reset` to clear between cases. */
const registry: CompactorEntry[] = [];
const stats = new Map<string, CompactStatEntry>();

export function registerCompactor(entry: CompactorEntry): void {
  if (registry.find((e) => e.id === entry.id)) {
    throw new Error(`compactor already registered: ${entry.id}`);
  }
  registry.push(entry);
}

export function unregisterCompactor(id: string): boolean {
  const idx = registry.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  registry.splice(idx, 1);
  return true;
}

export function resetCompactors(): void {
  registry.length = 0;
  stats.clear();
}

export function listCompactors(): readonly string[] {
  return registry.map((e) => e.id);
}

export function getCompactionStats(): ReadonlyMap<string, CompactStatEntry> {
  return new Map(stats);
}

export function resetCompactionStats(): void {
  stats.clear();
}

function bump(id: string, savedBytes: number): void {
  const entry = stats.get(id) ?? { hits: 0, savedBytes: 0 };
  entry.hits += 1;
  entry.savedBytes += Math.max(0, savedBytes);
  stats.set(id, entry);
}

/** Returns the first registered filter whose match() returns true. */
export function selectCompactor(
  cmd: string,
  argv: readonly string[],
  runtime: CompactorRuntime,
): CompactorEntry | null {
  if (!runtime.enabled) return null;
  const head = argv[0] ?? "";
  // exclude takes basename of the leading argv token so "git" disables
  // every git-* filter without listing each id.
  if (head && runtime.exclude.has(head)) return null;
  for (const entry of registry) {
    if (entry.match(argv, cmd)) return entry;
  }
  return null;
}

export function applyCompactor(
  cmd: string,
  output: string,
  opts: {
    exitCode: number | null;
    timedOut: boolean;
    runtime?: CompactorRuntime;
    /** Pre-tokenized argv (avoids double-tokenize). */
    argv?: readonly string[];
  },
): CompactResult {
  const runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const raw = output ?? "";
  if (!runtime.enabled) {
    return { compact: raw, raw, savedBytes: 0, filter: "disabled" };
  }
  const argv = opts.argv ?? tokenizeCommand(cmd);
  if (argv.length === 0) {
    return { compact: raw, raw, savedBytes: 0, filter: "passthrough" };
  }
  const entry = selectCompactor(cmd, argv, runtime);
  if (!entry) return { compact: raw, raw, savedBytes: 0, filter: "passthrough" };
  let compact: string | null;
  try {
    compact = entry.filter({
      cmd,
      argv,
      output: raw,
      exitCode: opts.exitCode,
      timedOut: opts.timedOut,
    });
  } catch (err) {
    // Filters are plugin-like; a throw should not break run_command. Log to
    // stderr so the bug is visible, then return raw + bump telemetry.
    console.warn(`[compact] filter ${entry.id} threw:`, err);
    bump("fallback", 0);
    return { compact: raw, raw, savedBytes: 0, filter: "fallback" };
  }
  if (compact === null || compact === raw) {
    return { compact: raw, raw, savedBytes: 0, filter: "passthrough" };
  }
  const saved = Math.max(0, raw.length - compact.length);
  bump(entry.id, saved);
  return { compact, raw, savedBytes: saved, filter: entry.id };
}

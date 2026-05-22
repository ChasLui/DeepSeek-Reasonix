/** Listing-style compactors: `ls`, `tree`, `find`. Counts + best-effort directory grouping. */

import stripAnsi from "strip-ansi";
import type { CompactInput, CompactorEntry } from "../registry.js";

const MAX_LINES = 50;

/** ls / tree: collapse long blocks to "<dir>: N entries" snapshots; for shorter lists pass-through. */
function listingFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  // Skip files-only short output.
  if (lines.length <= MAX_LINES) return null;
  // Treat `ls -la` blocks: "total N" header then `permissions … name`.
  const isLsLong = /^total\s+\d+/.test(lines[0] ?? "");
  if (isLsLong) {
    const entries = lines.slice(1).map((l) => {
      const parts = l.split(/\s+/);
      // permissions, links, owner, group, size, mon, day, time, name
      return parts.slice(8).join(" ");
    });
    return formatFileList(`ls -l — ${entries.length} entries`, entries);
  }
  // tree output keeps everything but is also long — preserve hierarchy by tail-trimming.
  if (lines.some((l) => /^[├└│ ]/.test(l))) {
    const total = lines.length;
    const dirs = lines.filter((l) => /\/$/.test(l)).length;
    return [
      `tree — ${total} lines, ${dirs} dir${dirs === 1 ? "" : "s"} (showing first ${MAX_LINES})`,
      ...lines.slice(0, MAX_LINES),
      `[… ${total - MAX_LINES} more lines …]`,
    ].join("\n");
  }
  // plain ls (one item per line, no headers): bucket by extension.
  return formatFileList(`ls — ${lines.length} entries`, lines);
}

function formatFileList(header: string, entries: readonly string[]): string {
  const byExt = new Map<string, number>();
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.endsWith("/")) {
      dirs.push(e);
      continue;
    }
    const dot = e.lastIndexOf(".");
    const ext = dot >= 0 ? e.slice(dot) : "(no ext)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const extBlock = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, n]) => `  ${ext}: ${n}`);
  const out: string[] = [header];
  if (dirs.length > 0) {
    out.push(`dirs (${dirs.length}):`);
    out.push(...dirs.slice(0, 20).map((d) => `  ${d}`));
    if (dirs.length > 20) out.push(`  … and ${dirs.length - 20} more dirs`);
  }
  if (extBlock.length > 0) {
    out.push("files by extension:");
    out.push(...extBlock);
  }
  return out.join("\n");
}

/** find: just count + show first N paths grouped by extension. */
function findFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_LINES) return null;
  return formatFileList(`find — ${lines.length} paths`, lines);
}

export const lsCompactor: CompactorEntry = {
  id: "ls",
  match: (argv) => argv[0] === "ls",
  filter: listingFilter,
};

export const treeCompactor: CompactorEntry = {
  id: "tree",
  match: (argv) => argv[0] === "tree",
  filter: listingFilter,
};

export const findCompactor: CompactorEntry = {
  id: "find",
  match: (argv) => argv[0] === "find",
  filter: findFilter,
};

export const listingCompactors: readonly CompactorEntry[] = [
  lsCompactor,
  treeCompactor,
  findCompactor,
];

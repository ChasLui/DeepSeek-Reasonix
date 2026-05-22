/** Linter / typechecker output compactors: eslint, biome, tsc. Group diagnostics by file. */

import stripAnsi from "strip-ansi";
import type { CompactInput, CompactorEntry } from "../registry.js";

const MAX_FILES_LISTED = 30;
const MAX_RULES_PER_FILE = 3;

interface FileGroup {
  file: string;
  count: number;
  rules: Map<string, number>;
}

function bumpRule(group: FileGroup, rule: string): void {
  group.count += 1;
  group.rules.set(rule, (group.rules.get(rule) ?? 0) + 1);
}

function topRules(g: FileGroup): string {
  const sorted = [...g.rules.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_RULES_PER_FILE);
  return sorted.map(([r, n]) => (n > 1 ? `${r} ×${n}` : r)).join(", ");
}

function formatGroups(label: string, groups: ReadonlyMap<string, FileGroup>): string {
  if (groups.size === 0) return `${label} — clean`;
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, g) => sum + g.count, 0);
  const head = `${label} — ${total} issue${total === 1 ? "" : "s"} across ${groups.size} file${groups.size === 1 ? "" : "s"}`;
  const body = sorted
    .slice(0, MAX_FILES_LISTED)
    .map((g) => `  ${g.file}: ${g.count}${g.rules.size > 0 ? ` (${topRules(g)})` : ""}`);
  const tail =
    sorted.length > MAX_FILES_LISTED
      ? [`  … and ${sorted.length - MAX_FILES_LISTED} more files`]
      : [];
  return [head, ...body, ...tail].join("\n");
}

/** eslint stylish: file header line then indented "L:C  level  msg  rule" rows. */
function eslintFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, FileGroup>();
  let curFile: string | null = null;
  let detected = false;
  for (const l of lines) {
    if (!l.trim()) continue;
    // file header: looks like a path and not indented
    if (!/^\s/.test(l) && /[\\/]/.test(l) && !l.startsWith("✖") && !/^\d+\s/.test(l)) {
      curFile = l.trim();
      if (!groups.has(curFile)) groups.set(curFile, { file: curFile, count: 0, rules: new Map() });
      continue;
    }
    const m = l.match(/^\s+\d+:\d+\s+(?:error|warning)\s+.+?(?:\s{2,}(\S+))?$/);
    if (m && curFile) {
      detected = true;
      const g = groups.get(curFile)!;
      bumpRule(g, (m[1] ?? "anonymous").trim());
    }
  }
  if (!detected) return null;
  return formatGroups("eslint", groups);
}

/** biome diagnostic header: "src/foo.ts:12:5 lint/suspicious/x  ━━" */
function biomeFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, FileGroup>();
  let detected = false;
  for (const l of lines) {
    const m = l.match(/^([^\s:][^\s]*?):\d+:\d+\s+([a-z][a-zA-Z\/-]+)\s/);
    if (!m) continue;
    detected = true;
    const file = m[1]!;
    const rule = m[2]!;
    const g = groups.get(file) ?? { file, count: 0, rules: new Map() };
    bumpRule(g, rule);
    groups.set(file, g);
  }
  if (!detected) return null;
  return formatGroups("biome", groups);
}

/** tsc errors: "src/foo.ts(12,5): error TS2304: Cannot find name 'X'." */
function tscFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, FileGroup>();
  let detected = false;
  for (const l of lines) {
    const m = l.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):/);
    if (!m) continue;
    detected = true;
    const file = m[1]!;
    const code = m[4]!;
    const g = groups.get(file) ?? { file, count: 0, rules: new Map() };
    bumpRule(g, code);
    groups.set(file, g);
  }
  if (!detected) {
    // Check for "Found N errors" so we don't return null on a green tsc run.
    if (/Found 0 errors/.test(text) || /Found \d+ errors? in \d+ files?/.test(text)) {
      return `tsc — ${
        text
          .split(/\r?\n/)
          .find((l) => /Found \d+ errors/.test(l))
          ?.trim() ?? "ok"
      }`;
    }
    return null;
  }
  return formatGroups("tsc", groups);
}

export const eslintCompactor: CompactorEntry = {
  id: "eslint",
  match: (argv) => argv.includes("eslint") || argv.some((t) => t.endsWith("/eslint")),
  filter: eslintFilter,
};

export const biomeCompactor: CompactorEntry = {
  id: "biome",
  match: (argv) =>
    argv.some((t) => t === "biome" || t.endsWith("/biome")) &&
    argv.some((t) => t === "check" || t === "lint" || t === "ci"),
  filter: biomeFilter,
};

export const tscCompactor: CompactorEntry = {
  id: "tsc",
  match: (argv) => argv.some((t) => t === "tsc" || t.endsWith("/tsc")),
  filter: tscFilter,
};

export const linterCompactors: readonly CompactorEntry[] = [
  eslintCompactor,
  biomeCompactor,
  tscCompactor,
];

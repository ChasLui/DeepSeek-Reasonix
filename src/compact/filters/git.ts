/** git status / log / diff compactors; filters return null when the shape is unrecognized so raw passes through. */

import stripAnsi from "strip-ansi";
import type { CompactInput, CompactorEntry } from "../registry.js";

/** Pre-subcommand git flags that consume the FOLLOWING token as their value.
 * The `=`-joined form (`--git-dir=.git`) is one token, handled by the generic
 * skip. Getting `-C`/`--git-dir`/`--work-tree` wrong breaks worktree compaction. */
const VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

/** "git" with first non-flag positional matching one of these handlers. */
function gitSubcommand(argv: readonly string[]): string | null {
  if (argv[0] !== "git") return null;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    // Value-taking flags must be checked before the generic dash skip, else
    // `-C` is swallowed but its path value gets mistaken for the subcommand.
    if (VALUE_FLAGS.has(tok)) {
      i += 1; // skip the value: `git -C path status`
      continue;
    }
    if (tok.startsWith("-")) continue;
    return tok;
  }
  return null;
}

/** status: collapse to one-liner per file. Handles porcelain v1 ("M  foo") and verbose ("On branch X / Changes …"). */
function statusFilter(input: CompactInput): string | null {
  const lines = stripAnsi(input.output).split(/\r?\n/);
  if (lines.length === 0) return null;
  // porcelain mode: every non-empty line is two columns then path.
  const porcelain = /^[ MADRCU?!]{2} /;
  const porcelainLines = lines.filter((l) => porcelain.test(l));
  if (porcelainLines.length > 0 && porcelainLines.length === lines.filter((l) => l.trim()).length) {
    return formatPorcelain(porcelainLines);
  }
  // verbose mode: extract by section. If we can't identify Changes/Untracked headers we abstain.
  const sections = parseVerboseStatus(lines);
  if (!sections) return null;
  return formatVerbose(sections);
}

function formatPorcelain(lines: readonly string[]): string {
  const counts = { M: 0, A: 0, D: 0, R: 0, U: 0, Q: 0 }; // Q = untracked (?)
  const files: string[] = [];
  for (const l of lines) {
    const x = l[0] ?? " ";
    const y = l[1] ?? " ";
    const path = l.slice(3).trim();
    if (x === "?" || y === "?") counts.Q += 1;
    else if (x === "U" || y === "U") counts.U += 1;
    else if (x === "R" || y === "R") counts.R += 1;
    else if (x === "D" || y === "D") counts.D += 1;
    else if (x === "A" || y === "A") counts.A += 1;
    else counts.M += 1;
    files.push(`  ${x}${y} ${path}`);
  }
  const summary = [
    counts.M ? `M:${counts.M}` : null,
    counts.A ? `A:${counts.A}` : null,
    counts.D ? `D:${counts.D}` : null,
    counts.R ? `R:${counts.R}` : null,
    counts.U ? `U:${counts.U}` : null,
    counts.Q ? `?:${counts.Q}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [`git status — ${summary} (${lines.length} entries)`, ...files].join("\n");
}

interface VerboseSections {
  branch: string | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

function parseVerboseStatus(lines: readonly string[]): VerboseSections | null {
  let branch: string | null = null;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let mode: "staged" | "unstaged" | "untracked" | null = null;
  for (const l of lines) {
    const m = l.match(/^On branch (\S+)/);
    if (m) {
      branch = m[1] ?? null;
      continue;
    }
    if (/^Changes to be committed:/.test(l)) {
      mode = "staged";
      continue;
    }
    if (/^Changes not staged for commit:/.test(l)) {
      mode = "unstaged";
      continue;
    }
    if (/^Untracked files:/.test(l)) {
      mode = "untracked";
      continue;
    }
    if (/^nothing to commit/.test(l)) {
      return { branch, staged: [], unstaged: [], untracked: [] };
    }
    if (mode && /^\s+/.test(l) && l.trim() && !/^\s+\(/.test(l)) {
      const path = l.trim().replace(/^[a-z-]+:\s+/i, "");
      const bucket = mode === "staged" ? staged : mode === "unstaged" ? unstaged : untracked;
      bucket.push(path);
    }
  }
  if (!branch && staged.length + unstaged.length + untracked.length === 0) return null;
  return { branch, staged, unstaged, untracked };
}

function formatVerbose(s: VerboseSections): string {
  const total = s.staged.length + s.unstaged.length + s.untracked.length;
  if (total === 0) {
    return `git status — clean${s.branch ? ` on ${s.branch}` : ""}`;
  }
  const summary = [
    s.staged.length ? `staged:${s.staged.length}` : null,
    s.unstaged.length ? `unstaged:${s.unstaged.length}` : null,
    s.untracked.length ? `untracked:${s.untracked.length}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const header = `git status — ${s.branch ?? "?"} — ${summary} (${total} entries)`;
  const body: string[] = [];
  if (s.staged.length) body.push("staged:", ...s.staged.map((p) => `  + ${p}`));
  if (s.unstaged.length) body.push("unstaged:", ...s.unstaged.map((p) => `  ~ ${p}`));
  if (s.untracked.length) body.push("untracked:", ...s.untracked.map((p) => `  ? ${p}`));
  return [header, ...body].join("\n");
}

/** log: detect already-oneline output and just count; full format → first line each commit. */
function logFilter(input: CompactInput): string | null {
  const lines = stripAnsi(input.output)
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  // Already oneline-ish (each line starts with hex sha). Just summarize count + cap each line.
  const onelineRe = /^[0-9a-f]{7,40}\b/;
  if (lines.every((l) => onelineRe.test(l))) {
    const capped = lines.map((l) => (l.length > 100 ? `${l.slice(0, 100)}…` : l));
    return [`git log — ${lines.length} commits`, ...capped].join("\n");
  }
  // Full format: collapse each commit block into "<sha> <subject>".
  const commits: string[] = [];
  let curSha: string | null = null;
  let curSubject: string | null = null;
  for (const l of lines) {
    const shaM = l.match(/^commit\s+([0-9a-f]{7,40})/);
    if (shaM) {
      if (curSha && curSubject) commits.push(`${curSha.slice(0, 8)} ${curSubject}`);
      curSha = shaM[1] ?? null;
      curSubject = null;
      continue;
    }
    if (!curSubject && curSha && /^\s+\S/.test(l)) {
      curSubject = l.trim();
    }
  }
  if (curSha && curSubject) commits.push(`${curSha.slice(0, 8)} ${curSubject}`);
  if (commits.length === 0) return null;
  return [`git log — ${commits.length} commits`, ...commits].join("\n");
}

/** diff: keep --- / +++ / @@ headers + +/- lines; collapse runs of context. */
function diffFilter(input: CompactInput): string | null {
  const raw = stripAnsi(input.output);
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return null;
  // Quick reject: only run if we see at least one diff header.
  if (!lines.some((l) => l.startsWith("@@") || l.startsWith("diff --git"))) return null;
  const out: string[] = [];
  let unchangedRun = 0;
  const flushUnchanged = () => {
    if (unchangedRun > 0) {
      out.push(`[… ${unchangedRun} unchanged ${unchangedRun === 1 ? "line" : "lines"} …]`);
      unchangedRun = 0;
    }
  };
  for (const l of lines) {
    const c = l[0] ?? "";
    if (
      l.startsWith("diff --git") ||
      l.startsWith("index ") ||
      l.startsWith("--- ") ||
      l.startsWith("+++ ") ||
      l.startsWith("@@") ||
      l.startsWith("similarity index") ||
      l.startsWith("rename from") ||
      l.startsWith("rename to") ||
      l.startsWith("new file") ||
      l.startsWith("deleted file") ||
      l.startsWith("Binary files")
    ) {
      flushUnchanged();
      out.push(l);
      continue;
    }
    if (c === "+" || c === "-" || c === "\\") {
      flushUnchanged();
      out.push(l);
      continue;
    }
    // context or blank line
    unchangedRun += 1;
  }
  flushUnchanged();
  if (out.length >= lines.length) return null;
  // Compute stats line.
  let added = 0;
  let removed = 0;
  for (const l of out) {
    if (l.startsWith("++") || l.startsWith("--")) continue;
    if (l.startsWith("+")) added += 1;
    else if (l.startsWith("-")) removed += 1;
  }
  return [`git diff — +${added}/-${removed}`, ...out].join("\n");
}

export const gitStatusCompactor: CompactorEntry = {
  id: "git-status",
  match: (argv) => gitSubcommand(argv) === "status",
  filter: statusFilter,
};

export const gitLogCompactor: CompactorEntry = {
  id: "git-log",
  match: (argv) => gitSubcommand(argv) === "log",
  filter: logFilter,
};

export const gitDiffCompactor: CompactorEntry = {
  id: "git-diff",
  match: (argv) => {
    const sub = gitSubcommand(argv);
    return sub === "diff" || sub === "show";
  },
  filter: diffFilter,
};

export const gitCompactors: readonly CompactorEntry[] = [
  gitStatusCompactor,
  gitLogCompactor,
  gitDiffCompactor,
];

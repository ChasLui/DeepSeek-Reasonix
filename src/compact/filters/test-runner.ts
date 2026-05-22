/** Failures-only filter for vitest / jest / pytest / cargo test / go test; abstains when summary is unrecognized. */

import stripAnsi from "strip-ansi";
import type { CompactInput, CompactorEntry } from "../registry.js";

/** True if any argv token (after the first) matches one of the inner-binary names. */
function argvMentions(argv: readonly string[], names: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (names.includes(tok)) return true;
    // basename match: "node_modules/.bin/vitest" → "vitest"
    const base = tok.replace(/^.*[\\/]/, "");
    if (names.includes(base)) return true;
  }
  return false;
}

const STACK_CAP = 20;

function vitestJestFilter(input: CompactInput, runner: "vitest" | "jest"): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  // Detect a summary line. vitest: "Test Files  N failed | M passed".
  // jest:   "Tests:       N failed, M passed, T total".
  const vitestSummary = lines.find((l) => /Test Files\s+/.test(l));
  const jestSummary = lines.find((l) => /^Tests:\s+/.test(l));
  if (!vitestSummary && !jestSummary) return null;

  const failBlocks: string[] = [];
  // vitest "FAIL " lines and jest "✕ " / "● " markers
  const failNameRe =
    runner === "vitest" ? /^\s*(?:FAIL|×)\s+(.+?)(?:\s+>.*)?$/ : /^\s*[✕●]\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(failNameRe);
    if (!m) continue;
    const name = (m[1] ?? "").trim();
    const stack: string[] = [];
    for (let j = i + 1; j < lines.length && stack.length < STACK_CAP; j++) {
      const l = lines[j]!;
      // Stop at the next FAIL marker or the summary line.
      if (failNameRe.test(l)) break;
      if (/^(?:Test Files|Tests:|Suites:)/.test(l)) break;
      stack.push(l);
    }
    while (stack.length > 0 && stack[stack.length - 1]!.trim() === "") stack.pop();
    failBlocks.push([`✗ ${name}`, ...stack].join("\n"));
  }

  const summary = vitestSummary ?? jestSummary ?? "";
  if (failBlocks.length === 0) {
    // exit 0 + no FAIL markers → call it a pass. Cap to summary line.
    if (input.exitCode === 0) return `${runner} ok — ${summary.trim()}`;
    // Non-zero exit but no detected failures → fall back to raw so the
    // model can debug whatever non-test problem occurred (config, etc.).
    return null;
  }
  return [
    `${runner} FAILED — ${failBlocks.length} failure${failBlocks.length === 1 ? "" : "s"} — ${summary.trim()}`,
    ...failBlocks,
  ].join("\n\n");
}

function pytestFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  // pytest end-of-run summary: "=== 2 failed, 18 passed in 1.23s ==="
  const summaryRe = /^=+ .*(\d+) failed|^=+ .*passed/;
  const summary = lines.find((l) => summaryRe.test(l));
  if (!summary) return null;

  const failedMatch = summary.match(/(\d+) failed/);
  const passedMatch = summary.match(/(\d+) passed/);
  const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0;
  if (failed === 0) {
    return `pytest ok — ${passedMatch ? `${passedMatch[1]} passed` : "passed"}`;
  }

  // Locate the FAILURES section: a banner line of "=" with " FAILURES " or " ERRORS "
  const banner = /^=+\s*(?:FAILURES|ERRORS)\s*=+$/;
  const fStart = lines.findIndex((l) => banner.test(l));
  if (fStart < 0) {
    return `pytest FAILED — ${summary.trim()}`;
  }
  // Each failure block starts with "_____ test_name _____" — the name itself
  // may contain underscores so we anchor on the banner (5+ leading and trailing _)
  // around a whitespace-bounded name rather than excluding _ from the name.
  const blockRe = /^_{5,}\s+(.+?)\s+_{5,}$/;
  const blocks: string[] = [];
  let curName: string | null = null;
  let curBody: string[] = [];
  const flush = () => {
    if (curName) {
      const trimmed = [...curBody];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
      blocks.push([`✗ ${curName}`, ...trimmed.slice(0, STACK_CAP)].join("\n"));
    }
    curName = null;
    curBody = [];
  };
  for (let i = fStart + 1; i < lines.length; i++) {
    const l = lines[i]!;
    // Stop on the final stats banner.
    if (/^=+ .*(?:passed|failed|error)/.test(l)) {
      flush();
      break;
    }
    const m = l.match(blockRe);
    if (m) {
      flush();
      curName = m[1]?.trim() ?? null;
      continue;
    }
    if (curName) curBody.push(l);
  }
  flush();

  return [`pytest FAILED — ${summary.trim()}`, ...blocks].join("\n\n");
}

function cargoTestFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  // "test result: ok. N passed; M failed; …"
  const resultLine = lines.find((l) => /^test result:/.test(l));
  if (!resultLine) return null;
  const failedM = resultLine.match(/(\d+) failed/);
  const failed = failedM ? Number.parseInt(failedM[1] ?? "0", 10) : 0;
  if (failed === 0) return `cargo test ok — ${resultLine.replace(/^test result:\s*/, "")}`;
  // Each failure block in cargo: "---- module::name stdout ----" then traceback then blank.
  const blockRe = /^----\s+(.+?)\s+stdout\s+----$/;
  const blocks: string[] = [];
  let curName: string | null = null;
  let curBody: string[] = [];
  const flush = () => {
    if (curName) {
      const trimmed = [...curBody];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
      blocks.push([`✗ ${curName}`, ...trimmed.slice(0, STACK_CAP)].join("\n"));
    }
    curName = null;
    curBody = [];
  };
  for (const l of lines) {
    const m = l.match(blockRe);
    if (m) {
      flush();
      curName = m[1] ?? null;
      continue;
    }
    if (curName) {
      // "failures:" block at the end is just a name list, skip.
      if (/^failures:$/.test(l)) {
        flush();
        continue;
      }
      curBody.push(l);
    }
  }
  flush();
  return [`cargo test FAILED — ${resultLine}`, ...blocks].join("\n\n");
}

function goTestFilter(input: CompactInput): string | null {
  const text = stripAnsi(input.output);
  const lines = text.split(/\r?\n/);
  // Two acceptable summary forms: "FAIL" line by itself or "ok  pkg  0.1s".
  const hasFail = lines.some((l) => /^---\s+FAIL:/.test(l) || /^FAIL\b/.test(l));
  const hasOk = lines.some((l) => /^ok\s+\S/.test(l));
  if (!hasFail && !hasOk) return null;
  if (!hasFail) {
    return `go test ok — ${lines.filter((l) => /^ok\s+\S/.test(l)).join(" · ")}`;
  }
  const blocks: string[] = [];
  let curName: string | null = null;
  let curBody: string[] = [];
  const flush = () => {
    if (curName) {
      blocks.push([`✗ ${curName}`, ...curBody.slice(0, STACK_CAP)].join("\n"));
    }
    curName = null;
    curBody = [];
  };
  for (const l of lines) {
    const m = l.match(/^---\s+FAIL:\s+(\S+)/);
    if (m) {
      flush();
      curName = m[1] ?? null;
      continue;
    }
    if (curName) {
      // Stop on next === RUN / next FAIL banner.
      if (/^===\s+RUN/.test(l) || /^FAIL\s/.test(l) || /^ok\s+\S/.test(l)) {
        flush();
        continue;
      }
      curBody.push(l);
    }
  }
  flush();
  const tail = lines.filter((l) => /^FAIL\b/.test(l)).join(" · ");
  return [
    `go test FAILED — ${tail || `${blocks.length} failure${blocks.length === 1 ? "" : "s"}`}`,
    ...blocks,
  ].join("\n\n");
}

export const vitestCompactor: CompactorEntry = {
  id: "vitest",
  match: (argv) => argvMentions(argv, ["vitest"]),
  filter: (input) => vitestJestFilter(input, "vitest"),
};

export const jestCompactor: CompactorEntry = {
  id: "jest",
  match: (argv) => argvMentions(argv, ["jest"]),
  filter: (input) => vitestJestFilter(input, "jest"),
};

export const pytestCompactor: CompactorEntry = {
  id: "pytest",
  match: (argv) => argvMentions(argv, ["pytest"]),
  filter: pytestFilter,
};

export const cargoTestCompactor: CompactorEntry = {
  id: "cargo-test",
  match: (argv) => argv[0] === "cargo" && argv.slice(1).some((t) => t === "test"),
  filter: cargoTestFilter,
};

export const goTestCompactor: CompactorEntry = {
  id: "go-test",
  match: (argv) => argv[0] === "go" && argv.slice(1).some((t) => t === "test"),
  filter: goTestFilter,
};

export const testRunnerCompactors: readonly CompactorEntry[] = [
  vitestCompactor,
  jestCompactor,
  pytestCompactor,
  cargoTestCompactor,
  goTestCompactor,
];

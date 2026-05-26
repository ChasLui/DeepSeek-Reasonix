#!/usr/bin/env node
import assert from "node:assert/strict";
import readline from "node:readline/promises";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
const OBSERVATIONS = [
  "no highlight",
  "highlight but clipboard empty",
  "highlight and clipboard contains selected text",
  "terminal bypass works only with Shift",
  "not reproducible",
];

if (process.argv.includes("--self-test")) {
  assert.equal(choiceToObservation("1"), OBSERVATIONS[0]);
  assert.equal(choiceToObservation("5"), OBSERVATIONS[4]);
  assert.equal(choiceToObservation("custom observation"), "custom observation");
  assert.equal(markdownCell("a | b\nc"), "a \\| b c");
  process.stdout.write("self-test ok\n");
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  process.stderr.write("This probe must run in a real interactive terminal.\n");
  process.exit(1);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

process.stdout.write("# E0 selection probe\n\n");
process.stdout.write(
  "This is a protocol-level reproduction helper, not a full Reasonix session.\n",
);
process.stdout.write(
  "It toggles the same 1000/1006 mouse tracking sequences used by Reasonix.\n\n",
);
process.stdout.write(`TERM=${process.env.TERM ?? ""}\n`);
process.stdout.write(`TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""}\n`);
process.stdout.write(`COLORTERM=${process.env.COLORTERM ?? ""}\n`);
process.stdout.write(`TMUX=${process.env.TMUX ? "yes" : "no"}\n`);
process.stdout.write(`SSH_TTY=${process.env.SSH_TTY ?? ""}\n\n`);

const defaultResult = await runPhase({
  title: "Default mouse tracking",
  mouse: true,
  instruction:
    "Try normal drag-select across the sample line, copy it, then press Enter in this terminal.",
});
const noMouseResult = await runPhase({
  title: "Mouse tracking disabled",
  mouse: false,
  instruction:
    "Try normal drag-select across the sample line, copy it, then press Enter in this terminal.",
});
const shiftResult = await runPhase({
  title: "Mouse tracking with terminal bypass",
  mouse: true,
  instruction: "Try Shift+Drag or the terminal-specific bypass gesture, copy it, then press Enter.",
});

cleanup();
const clipboardResult = await askObservation("Clipboard result summary");
const terminal = await askText(
  "Terminal name/version",
  process.env.TERM_PROGRAM || process.env.TERM || "",
);
const os = await askText("OS", `${process.platform} ${process.arch}`);

process.stdout.write(
  "\n| Terminal | OS | Command | Default drag-select result | `--no-mouse` result | Shift+Drag result | Clipboard result | Evidence |\n",
);
process.stdout.write("|---|---|---|---|---|---|---|---|\n");
process.stdout.write(
  `| ${markdownCell(terminal)} | ${markdownCell(os)} | protocol helper: \`node docs/spike/tui-selection/e0-selection-probe.mjs\` | ${markdownCell(defaultResult)} | ${markdownCell(noMouseResult)} | ${markdownCell(shiftResult)} | ${markdownCell(clipboardResult)} | paste this row into manual-terminal-checklist.md |\n`,
);

async function runPhase({ title, mouse, instruction }) {
  process.stdout.write(`\n## ${title}\n`);
  process.stdout.write(mouse ? ENABLE_MOUSE : DISABLE_MOUSE);
  renderSample();
  process.stdout.write(`${instruction}\n`);
  await waitForEnterIgnoringMouseBytes();
  process.stdout.write(DISABLE_MOUSE);
  return askObservation(title);
}

function renderSample() {
  process.stdout.write("\n--- selection sample start ---\n");
  process.stdout.write("select this exact line: Reasonix selection probe 中 emoji-test\n");
  process.stdout.write("--- selection sample end ---\n");
}

function waitForEnterIgnoringMouseBytes() {
  return new Promise((resolve) => {
    const onData = (chunk) => {
      if (chunk.includes(0x0d) || chunk.includes(0x0a)) {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve();
      }
    };
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

async function askObservation(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`\n${label} observation:\n`);
  OBSERVATIONS.forEach((item, idx) => {
    process.stdout.write(`  ${idx + 1}. ${item}\n`);
  });
  const answer = await rl.question("> ");
  rl.close();
  return choiceToObservation(answer);
}

async function askText(label, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  rl.close();
  return answer.trim() || fallback;
}

function cleanup() {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore non-raw cleanup
  }
  process.stdin.pause();
  process.stdout.write(DISABLE_MOUSE);
}

function choiceToObservation(input) {
  const trimmed = input.trim();
  const idx = Number.parseInt(trimmed, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= OBSERVATIONS.length) return OBSERVATIONS[idx - 1];
  return trimmed || "not recorded";
}

function markdownCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

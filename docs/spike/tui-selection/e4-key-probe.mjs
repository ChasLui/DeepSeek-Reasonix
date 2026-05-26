#!/usr/bin/env node
import assert from "node:assert/strict";

const candidates = [
  {
    name: "Ctrl+S",
    expected: "ctrl-s",
    prompt: "Press Ctrl+S. If the terminal freezes, press Ctrl+Q to resume.",
  },
  { name: "Alt+M", expected: "alt-m", prompt: "Press Alt+M." },
  { name: "Ctrl+T", expected: "ctrl-t", prompt: "Press Ctrl+T." },
];

if (process.argv.includes("--self-test")) {
  assert.equal(classify(Buffer.from([0x13])), "ctrl-s");
  assert.equal(classify(Buffer.from([0x14])), "ctrl-t");
  assert.equal(classify(Buffer.from([0x1b, 0x6d])), "alt-m");
  assert.equal(classify(Buffer.from([0x1b, 0x4d])), "alt-shift-m-or-x10-prefix");
  assert.equal(classify(Buffer.from([])), "timeout/no-bytes");
  process.stdout.write("self-test ok\n");
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  process.stderr.write("This probe must run in a real interactive terminal.\n");
  process.exit(1);
}

const results = [];
process.stdout.write("# E4 key probe\n\n");
process.stdout.write(`TERM=${process.env.TERM ?? ""}\n`);
process.stdout.write(`TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""}\n`);
process.stdout.write(`COLORTERM=${process.env.COLORTERM ?? ""}\n`);
process.stdout.write(`TMUX=${process.env.TMUX ? "yes" : "no"}\n`);
process.stdout.write(`SSH_TTY=${process.env.SSH_TTY ?? ""}\n\n`);

for (const candidate of candidates) {
  const bytes = await readOne(candidate.prompt, 5000);
  const observed = classify(bytes);
  results.push({
    ...candidate,
    bytes,
    observed,
    reachesApp: observed === candidate.expected ? "yes" : "no",
  });
}

process.stdout.write(
  "\n| Candidate | Expected | Observed bytes | Classification | Reaches app? |\n",
);
process.stdout.write("|---|---|---|---|---|\n");
for (const result of results) {
  process.stdout.write(
    `| ${result.name} | ${result.expected} | ${hex(result.bytes)} | ${result.observed} | ${result.reachesApp} |\n`,
  );
}

function readOne(prompt, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdout.write(`${prompt}\n> `);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.once("data", onData);
  });
}

function classify(bytes) {
  if (bytes.length === 0) return "timeout/no-bytes";
  if (bytes.length === 1 && bytes[0] === 0x13) return "ctrl-s";
  if (bytes.length === 1 && bytes[0] === 0x14) return "ctrl-t";
  if (bytes.length === 2 && bytes[0] === 0x1b && bytes[1] === 0x6d) return "alt-m";
  if (bytes.length === 2 && bytes[0] === 0x1b && bytes[1] === 0x4d)
    return "alt-shift-m-or-x10-prefix";
  return "other";
}

function hex(bytes) {
  if (bytes.length === 0) return "(none)";
  return [...bytes].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(" ");
}

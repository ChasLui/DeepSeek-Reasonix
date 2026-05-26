#!/usr/bin/env node
import assert from "node:assert/strict";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE_RE = new RegExp(["\\x1b", "\\[<", "(\\d+);(\\d+);(\\d+)([Mm])"].join(""));
const prefixRows = Number.parseInt(process.env.PREFIX_ROWS ?? "0", 10) || 0;
const expectedBodyRow = prefixRows + 3;

if (process.argv.includes("--self-test")) {
  assert.deepEqual(parseSgrMouse("\x1b[<0;3;5M"), { button: 0, col: 3, row: 5, kind: "press" });
  assert.deepEqual(parseSgrMouse("\x1b[<0;3;5m"), { button: 0, col: 3, row: 5, kind: "release" });
  assert.equal(parseSgrMouse("abc"), null);
  assert.equal(mapBodyRow(5, 2), 0);
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

process.stdout.write(ENABLE_MOUSE);
process.stdin.setRawMode(true);
process.stdin.resume();
renderFixture();

const timeout = setTimeout(() => {
  cleanup();
  process.stderr.write("\nTimed out waiting for a mouse click.\n");
  process.exit(1);
}, 15000);

process.stdin.on("data", (chunk) => {
  const ev = parseSgrMouse(chunk.toString("binary"));
  if (!ev || ev.kind !== "press") return;
  clearTimeout(timeout);
  const bodyRow = mapBodyRow(ev.row, prefixRows);
  const bodyCol = ev.col - 3;
  cleanup();
  process.stdout.write(
    "\n\n| Prefix rows | Report row | Report col | Expected body row | Mapped body row | Mapped cell | Result |\n",
  );
  process.stdout.write("|---:|---:|---:|---:|---:|---:|---|\n");
  process.stdout.write(
    `| ${prefixRows} | ${ev.row} | ${ev.col} | ${expectedBodyRow} | ${bodyRow} | ${bodyCol} | ${bodyRow === 0 ? "PASS" : "FAIL"} |\n`,
  );
  process.exit(bodyRow === 0 ? 0 : 1);
});

function renderFixture() {
  process.stdout.write("\x1b[2J\x1b[H");
  for (let i = 0; i < prefixRows; i += 1) {
    process.stdout.write(`prefix row ${i + 1}\n`);
  }
  process.stdout.write("CopyMode title row\n");
  process.stdout.write("CopyMode help row\n");
  process.stdout.write("  hello world  <= click the h in this line\n");
  process.stdout.write("  second body line\n\n");
  process.stdout.write(
    `PREFIX_ROWS=${prefixRows}; expected terminal row for body line 0 is ${expectedBodyRow}.\n`,
  );
  process.stdout.write("Click the h in 'hello world'. Ctrl+C cancels.\n");
}

function cleanup() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(DISABLE_MOUSE);
}

function parseSgrMouse(s) {
  const m = SGR_MOUSE_RE.exec(s);
  if (!m) return null;
  return {
    button: Number.parseInt(m[1], 10),
    col: Number.parseInt(m[2], 10),
    row: Number.parseInt(m[3], 10),
    kind: m[4] === "m" ? "release" : "press",
  };
}

function mapBodyRow(mouseRow, prefixCount) {
  return mouseRow - (prefixCount + 3);
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const REQUIRED_OUT_DIR_FILES = [
  "gui-capability.md",
  "local-probes.log",
  "stdin-parser-probe.txt",
  "clip-to-cells-probe.txt",
  "e3-render-samples/combined.ansi",
];
const E3_SCHEMES = new Set(["chalk.inverse", "solid bg", "raw inverse"]);
const MATRIX_CONTEXTS = new Set(["local", "ssh", "tmux"]);
const YES_NO = new Set(["yes", "no"]);
const YES_NO_TIMEOUT = new Set(["yes", "no", "timeout/no-bytes"]);
const BINDINGS = new Set(["Alt+M", "Ctrl+T", "Ctrl+S", "other"]);
const OBSERVATIONS = new Set([
  "no highlight",
  "highlight but clipboard empty",
  "highlight and clipboard contains selected text",
  "terminal bypass works only with Shift",
  "not reproducible",
]);
const SELECTION_RESTORED = "highlight and clipboard contains selected text";
const SHIFT_BYPASS_RESTORED = new Set([
  SELECTION_RESTORED,
  "terminal bypass works only with Shift",
]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.stdout.write("self-test ok\n");
  process.exit(0);
}

const evidenceFile = process.argv[2];
if (!evidenceFile) {
  process.stderr.write(
    "usage: node docs/spike/tui-selection/verify-manual-evidence.mjs <manual-evidence.json>\n",
  );
  process.exit(2);
}

const result = verifyEvidenceFile(evidenceFile);
for (const line of result.lines) process.stdout.write(`${line}\n`);
process.exit(result.failures === 0 ? 0 : 1);

function verifyEvidenceFile(file) {
  const baseDir = dirname(file);
  const data = JSON.parse(readFileText(file));
  const lines = [];
  let failures = 0;

  const check = (condition, label) => {
    if (condition) {
      lines.push(`PASS ${label}`);
    } else {
      lines.push(`FAIL ${label}`);
      failures += 1;
    }
  };

  check(data.schemaVersion === 1, "schemaVersion is 1");
  const req = {
    minE0Rows: numberOr(data.requirements?.minE0Rows, 1),
    minE3Rows: numberOr(data.requirements?.minE3Rows, 12),
    minE4Rows: numberOr(data.requirements?.minE4Rows, 15),
    minFr104Rows: numberOr(data.requirements?.minFr104Rows, 7),
    minE2Rows: numberOr(data.requirements?.minE2Rows, 30),
  };

  const outDir = stringOr(data.outDir, "");
  check(outDir.length > 0 && existsDirectory(outDir), `outDir exists: ${outDir}`);
  if (outDir.length > 0 && existsDirectory(outDir)) {
    for (const rel of REQUIRED_OUT_DIR_FILES) {
      check(existsNonEmpty(join(outDir, rel)), `OUT_DIR artifact exists and is non-empty: ${rel}`);
    }
  }

  const e0 = arrayOr(data.e0);
  check(e0.length >= req.minE0Rows, `E0 rows >= ${req.minE0Rows}`);
  for (const [idx, row] of e0.entries()) verifyE0Row(row, idx, baseDir, check);
  const validE0Rows = e0.filter((row) => evidenceFilesExist(row?.evidence, baseDir));
  check(
    validE0Rows.some((row) => row?.defaultDragSelectResult === SELECTION_RESTORED),
    "E0 proves default native drag-select works",
  );
  check(
    validE0Rows.some((row) => OBSERVATIONS.has(row?.mouseOnDragSelectResult)),
    "E0 records /mouse on drag behavior",
  );
  check(
    validE0Rows.some((row) => row?.mouseOffAfterMouseOnResult === SELECTION_RESTORED),
    "E0 proves /mouse off restores selection after /mouse on",
  );
  check(
    validE0Rows.some(isE0FullContrastRow),
    "E0 includes same-row default native /mouse on /mouse off contrast",
  );

  const pathEConsidered = data.pathEConsidered === true;
  const e2 = arrayOr(data.e2);
  if (pathEConsidered) {
    check(e2.length >= req.minE2Rows, `E2 rows >= ${req.minE2Rows} when Path E is considered`);
    for (const [idx, row] of e2.entries()) verifyE2Row(row, idx, baseDir, check);
    check(hasAllContexts(e2), "E2 includes local/ssh/tmux contexts");
    check(uniqueNonEmpty(e2, "terminal").size >= 5, "E2 includes at least 5 terminals");
    check(
      e2.some((row) => Number.isInteger(row?.width) && row.width <= 80),
      "E2 includes narrow width <=80",
    );
    check(
      e2.some((row) => Number.isInteger(row?.width) && row.width > 223),
      "E2 includes wide width >223",
    );
  } else {
    check(true, "E2 matrix not required because pathEConsidered=false");
  }

  const e3 = arrayOr(data.e3);
  check(e3.length >= req.minE3Rows, `E3 rows >= ${req.minE3Rows}`);
  for (const [idx, row] of e3.entries()) verifyE3Row(row, idx, baseDir, check);
  for (const scheme of E3_SCHEMES) {
    check(
      e3.some((row) => row?.scheme === scheme),
      `E3 includes scheme: ${scheme}`,
    );
  }
  check(completeE3Terminals(e3) >= 4, "E3 includes at least 4 terminals with all schemes");

  const e4 = arrayOr(data.e4);
  check(e4.length >= req.minE4Rows, `E4 rows >= ${req.minE4Rows}`);
  for (const [idx, row] of e4.entries()) verifyE4Row(row, idx, baseDir, check);
  check(hasAllContexts(e4), "E4 includes local/ssh/tmux contexts");
  check(uniqueNonEmpty(e4, "terminal").size >= 5, "E4 includes at least 5 terminals");
  check(hasIxonState(e4, "enabled"), "E4 includes ixon enabled rows");
  check(hasIxonState(e4, "disabled"), "E4 includes ixon disabled rows");

  const fr104 = arrayOr(data.fr104);
  check(fr104.length >= req.minFr104Rows, `FR-104 rows >= ${req.minFr104Rows}`);
  for (const [idx, row] of fr104.entries()) verifyFr104Row(row, idx, baseDir, check);
  check(hasAllContexts(fr104), "FR-104 includes local/ssh/tmux contexts");
  check(
    fr104.some((row) => row?.prefixRows === 0),
    "FR-104 includes prefixRows=0",
  );
  check(
    fr104.some((row) => row?.prefixRows === 1),
    "FR-104 includes prefixRows=1",
  );

  return { lines, failures };
}

function verifyE0Row(row, idx, baseDir, check) {
  const p = `E0[${idx}]`;
  check(nonEmpty(row?.terminal), `${p} terminal`);
  check(nonEmpty(row?.os), `${p} os`);
  check(nonEmpty(row?.command), `${p} command`);
  check(
    OBSERVATIONS.has(row?.defaultDragSelectResult),
    `${p} defaultDragSelectResult known observation`,
  );
  check(
    OBSERVATIONS.has(row?.mouseOnDragSelectResult),
    `${p} mouseOnDragSelectResult known observation`,
  );
  check(
    OBSERVATIONS.has(row?.mouseOffAfterMouseOnResult),
    `${p} mouseOffAfterMouseOnResult known observation`,
  );
  check(
    OBSERVATIONS.has(row?.shiftDragWhileMouseOnResult),
    `${p} shiftDragWhileMouseOnResult known observation`,
  );
  check(OBSERVATIONS.has(row?.clipboardResult), `${p} clipboardResult known observation`);
  verifyEvidenceFiles(row?.evidence, `${p} evidence`, baseDir, check);
}

function verifyE2Row(row, idx, baseDir, check) {
  const p = `E2[${idx}]`;
  check(nonEmpty(row?.terminal), `${p} terminal`);
  check(MATRIX_CONTEXTS.has(row?.context), `${p} context is local/ssh/tmux`);
  check(Number.isInteger(row?.width) && row.width > 0, `${p} width`);
  check(YES_NO.has(row?.wheelTerminalSends), `${p} wheelTerminalSends yes/no`);
  check(YES_NO.has(row?.repoReceives), `${p} repoReceives yes/no`);
  check(YES_NO.has(row?.composerPolluted), `${p} composerPolluted yes/no`);
  check(YES_NO.has(row?.dragSelectRestored), `${p} dragSelectRestored yes/no`);
  verifyEvidenceFiles(row?.evidence, `${p} evidence`, baseDir, check);
}

function verifyE3Row(row, idx, baseDir, check) {
  const p = `E3[${idx}]`;
  check(nonEmpty(row?.terminal), `${p} terminal`);
  check(nonEmpty(row?.os), `${p} os`);
  check(nonEmpty(row?.sample), `${p} sample`);
  check(E3_SCHEMES.has(row?.scheme), `${p} scheme`);
  check(
    Number.isInteger(row?.readability) && row.readability >= 1 && row.readability <= 5,
    `${p} readability 1-5`,
  );
  check(YES_NO.has(row?.colorResetCorrect), `${p} colorResetCorrect yes/no`);
  check(YES_NO.has(row?.eolSpill), `${p} eolSpill yes/no`);
  check(
    existsScreenshot(resolveEvidencePath(baseDir, stringOr(row?.screenshot, ""))),
    `${p} screenshot exists with PNG/JPEG magic bytes`,
  );
}

function verifyE4Row(row, idx, baseDir, check) {
  const p = `E4[${idx}]`;
  check(nonEmpty(row?.terminal), `${p} terminal`);
  check(MATRIX_CONTEXTS.has(row?.context), `${p} context is local/ssh/tmux`);
  check(nonEmpty(row?.ixonState), `${p} ixonState`);
  check(YES_NO_TIMEOUT.has(row?.ctrlSReachesApp), `${p} ctrlSReachesApp`);
  check(YES_NO_TIMEOUT.has(row?.altMReachesApp), `${p} altMReachesApp`);
  check(YES_NO_TIMEOUT.has(row?.ctrlTReachesApp), `${p} ctrlTReachesApp`);
  check(BINDINGS.has(row?.recommendedBinding), `${p} recommendedBinding`);
  verifyEvidenceFiles(row?.evidence, `${p} evidence`, baseDir, check);
}

function verifyFr104Row(row, idx, baseDir, check) {
  const p = `FR104[${idx}]`;
  check(nonEmpty(row?.terminal), `${p} terminal`);
  check(MATRIX_CONTEXTS.has(row?.context), `${p} context is local/ssh/tmux`);
  check(Number.isInteger(row?.prefixRows) && row.prefixRows >= 0, `${p} prefixRows`);
  check(row?.probeResult === "PASS", `${p} probeResult PASS`);
  verifyEvidenceFiles(row?.evidence, `${p} evidence`, baseDir, check);
}

function verifyEvidenceFiles(value, label, baseDir, check) {
  const files = arrayOr(value);
  check(files.length > 0, `${label} has at least one file`);
  for (const file of files) {
    check(
      existsNonEmpty(resolveEvidencePath(baseDir, stringOr(file, ""))),
      `${label} file exists and is non-empty: ${file}`,
    );
  }
}

function evidenceFilesExist(value, baseDir) {
  const files = arrayOr(value);
  return (
    files.length > 0 &&
    files.every((file) => existsNonEmpty(resolveEvidencePath(baseDir, stringOr(file, ""))))
  );
}

function isE0FullContrastRow(row) {
  return (
    row?.defaultDragSelectResult === SELECTION_RESTORED &&
    OBSERVATIONS.has(row?.mouseOnDragSelectResult) &&
    row?.mouseOffAfterMouseOnResult === SELECTION_RESTORED &&
    SHIFT_BYPASS_RESTORED.has(row?.shiftDragWhileMouseOnResult) &&
    row?.clipboardResult === SELECTION_RESTORED
  );
}

function readFileText(file) {
  return readFileSync(file, "utf8");
}

function resolveEvidencePath(baseDir, file) {
  if (file.length === 0) return "";
  return isAbsolute(file) ? file : join(baseDir, file);
}

function existsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existsNonEmpty(path) {
  try {
    return path.length > 0 && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function existsScreenshot(path) {
  try {
    if (path.length === 0 || !statSync(path).isFile()) return false;
    const buf = readFileSync(path);
    return startsWithBytes(buf, PNG_MAGIC) || startsWithBytes(buf, JPEG_MAGIC);
  } catch {
    return false;
  }
}

function startsWithBytes(buf, prefix) {
  return buf.length >= prefix.length && prefix.every((byte, idx) => buf[idx] === byte);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function arrayOr(value) {
  return Array.isArray(value) ? value : [];
}

function hasAllContexts(rows) {
  const contexts = uniqueNonEmpty(rows, "context");
  return [...MATRIX_CONTEXTS].every((context) => contexts.has(context));
}

function hasIxonState(rows, target) {
  return rows.some((row) => {
    const value = typeof row?.ixonState === "string" ? row.ixonState.toLowerCase() : "";
    return target === "enabled"
      ? /(^|[^-])\bixon\b/.test(value) && !value.includes("-ixon") && !value.includes("disabled")
      : value.includes("-ixon") || value.includes("disabled");
  });
}

function completeE3Terminals(rows) {
  let count = 0;
  for (const terminal of uniqueNonEmpty(rows, "terminal")) {
    const schemes = new Set(
      rows.filter((row) => row?.terminal === terminal).map((row) => row?.scheme),
    );
    if ([...E3_SCHEMES].every((scheme) => schemes.has(scheme))) count += 1;
  }
  return count;
}

function uniqueNonEmpty(rows, key) {
  return new Set(
    rows
      .map((row) => row?.[key])
      .filter((value) => typeof value === "string" && value.trim().length > 0),
  );
}

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "reasonix-manual-evidence-"));
  try {
    const outDir = join(tmp, "out");
    mkdirSync(join(outDir, "e3-render-samples"), { recursive: true });
    for (const rel of REQUIRED_OUT_DIR_FILES) {
      const path = join(outDir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "ok\n");
    }
    mkdirSync(join(tmp, "screenshots"), { recursive: true });
    const e3 = [];
    for (const terminal of ["Terminal.app", "Ghostty", "iTerm2", "Alacritty"]) {
      for (const scheme of E3_SCHEMES) {
        const file = `screenshots/${terminal.replaceAll(".", "-")}-${scheme.replaceAll(" ", "-")}.png`;
        writeFileSync(join(tmp, file), TINY_PNG);
        e3.push({
          terminal,
          os: "macOS",
          sample: "ToolCard syntax + CJK + emoji",
          scheme,
          readability: 4,
          colorResetCorrect: "yes",
          eolSpill: "no",
          screenshot: file,
        });
      }
    }
    const e4 = makeE4(tmp);
    const fr104 = [];
    for (let i = 0; i < 7; i += 1) {
      const file = `fr104-${i}.txt`;
      writeFileSync(join(tmp, file), "ok\n");
      fr104.push({
        terminal: `terminal-${i}`,
        context: i < 3 ? "local" : i < 5 ? "ssh" : "tmux",
        prefixRows: i === 0 ? 0 : 1,
        probeResult: "PASS",
        evidence: [file],
      });
    }
    writeFileSync(join(tmp, "e0.txt"), "ok\n");
    const good = {
      schemaVersion: 1,
      pathEConsidered: false,
      outDir,
      e0: [
        {
          terminal: "Terminal.app",
          os: "macOS",
          command: "node docs/spike/tui-selection/e0-selection-probe.mjs",
          defaultDragSelectResult: "highlight and clipboard contains selected text",
          mouseOnDragSelectResult: "no highlight",
          mouseOffAfterMouseOnResult: "highlight and clipboard contains selected text",
          shiftDragWhileMouseOnResult: "terminal bypass works only with Shift",
          clipboardResult: "highlight and clipboard contains selected text",
          evidence: ["e0.txt"],
        },
      ],
      e2: [],
      e3,
      e4,
      fr104,
    };
    const goodFile = join(tmp, "manual-evidence.json");
    writeFileSync(goodFile, `${JSON.stringify(good, null, 2)}\n`);
    assert.equal(verifyEvidenceFile(goodFile).failures, 0);
    const pathEFile = join(tmp, "path-e.json");
    writeFileSync(
      pathEFile,
      `${JSON.stringify({ ...good, pathEConsidered: true, e2: makeE2(tmp) }, null, 2)}\n`,
    );
    assert.equal(verifyEvidenceFile(pathEFile).failures, 0);
    const badFile = join(tmp, "bad.json");
    writeFileSync(badFile, `${JSON.stringify({ ...good, e3: [] }, null, 2)}\n`);
    assert.ok(verifyEvidenceFile(badFile).failures > 0);
    const badE0File = join(tmp, "bad-e0.json");
    writeFileSync(
      badE0File,
      `${JSON.stringify(
        {
          ...good,
          e0: [{ ...good.e0[0], defaultDragSelectResult: "no highlight" }],
        },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badE0File).failures > 0);
    const badE4File = join(tmp, "bad-e4-context.json");
    writeFileSync(
      badE4File,
      `${JSON.stringify({ ...good, e4: good.e4.map((row) => ({ ...row, context: "local" })) }, null, 2)}\n`,
    );
    assert.ok(verifyEvidenceFile(badE4File).failures > 0);
    const badE4IxonFile = join(tmp, "bad-e4-ixon.json");
    writeFileSync(
      badE4IxonFile,
      `${JSON.stringify(
        { ...good, e4: good.e4.map((row) => ({ ...row, ixonState: "ixon enabled" })) },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badE4IxonFile).failures > 0);
    const badE3TerminalFile = join(tmp, "bad-e3-terminal.json");
    writeFileSync(
      badE3TerminalFile,
      `${JSON.stringify(
        { ...good, e3: good.e3.map((row) => ({ ...row, terminal: "Terminal.app" })) },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badE3TerminalFile).failures > 0);
    const badFr104File = join(tmp, "bad-fr104-context.json");
    writeFileSync(
      badFr104File,
      `${JSON.stringify(
        { ...good, fr104: good.fr104.map((row) => ({ ...row, context: "local" })) },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badFr104File).failures > 0);
    const badE2File = join(tmp, "bad-e2-width.json");
    writeFileSync(
      badE2File,
      `${JSON.stringify(
        {
          ...good,
          pathEConsidered: true,
          e2: makeE2(tmp).map((row) => ({ ...row, width: 80 })),
        },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badE2File).failures > 0);
    const fakeShot = "screenshots/not-a-real-screenshot.png";
    writeFileSync(join(tmp, fakeShot), "not a png\n");
    const badScreenshotFile = join(tmp, "bad-screenshot.json");
    writeFileSync(
      badScreenshotFile,
      `${JSON.stringify(
        { ...good, e3: [{ ...good.e3[0], screenshot: fakeShot }, ...good.e3.slice(1)] },
        null,
        2,
      )}\n`,
    );
    assert.ok(verifyEvidenceFile(badScreenshotFile).failures > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeE2(tmp) {
  const rows = [];
  for (let terminal = 0; terminal < 5; terminal += 1) {
    for (const context of MATRIX_CONTEXTS) {
      for (const width of [80, 250]) {
        const file = `e2-${terminal}-${context}-${width}.txt`;
        writeFileSync(join(tmp, file), "ok\n");
        rows.push({
          terminal: `terminal-${terminal}`,
          context,
          width,
          wheelTerminalSends: "yes",
          repoReceives: "yes",
          composerPolluted: "no",
          dragSelectRestored: "yes",
          evidence: [file],
        });
      }
    }
  }
  return rows;
}

function makeE4(tmp) {
  const rows = [];
  for (let terminal = 0; terminal < 5; terminal += 1) {
    for (const context of MATRIX_CONTEXTS) {
      for (const ixonState of ["ixon enabled; stop = ^S", "-ixon disabled"]) {
        const file = `e4-${terminal}-${context}-${ixonState.startsWith("-") ? "off" : "on"}.txt`;
        writeFileSync(join(tmp, file), "ok\n");
        rows.push({
          terminal: `terminal-${terminal}`,
          context,
          ixonState,
          ctrlSReachesApp: ixonState.startsWith("-") ? "yes" : "no",
          altMReachesApp: "yes",
          ctrlTReachesApp: "yes",
          recommendedBinding: "Alt+M",
          evidence: [file],
        });
      }
    }
  }
  return rows;
}

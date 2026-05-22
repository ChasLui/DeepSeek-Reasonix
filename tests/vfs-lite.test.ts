/** VFS-Lite — byte-identical contract with /bin/bash for the white-listed commands. */

import { spawn } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunInVfs,
  getVfsStats,
  isVfsBlacklisted,
  markVfsFallback,
  resetVfsState,
  resetVfsStats,
  runInVfs,
} from "../src/tools/shell/vfs-lite.js";

let root: string;
let fileA: string;
let fileB: string;

beforeAll(async () => {
  root = await fs.realpath(mkdtempSync(join(tmpdir(), "vfs-lite-")));
  fileA = join(root, "a.txt");
  fileB = join(root, "b.txt");
  // 10 lines with newline at end — common case
  writeFileSync(fileA, `${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
  // 3 lines without trailing newline — edge case for tail
  writeFileSync(fileB, "x\ny\nz");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetVfsState();
  resetVfsStats();
});

function bashRun(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", cmd], {
      cwd,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

describe("canRunInVfs gating", () => {
  it("accepts whitelist commands without metacharacters", () => {
    expect(canRunInVfs(["cat", "x.txt"])).toBe(true);
    expect(canRunInVfs(["head", "-5", "x.txt"])).toBe(true);
    expect(canRunInVfs(["tail", "-n", "3", "x.txt"])).toBe(true);
    expect(canRunInVfs(["printf", "%s\\n", "hi"])).toBe(true);
  });

  it("rejects non-whitelisted commands", () => {
    expect(canRunInVfs(["ls", "x"])).toBe(false);
    expect(canRunInVfs(["grep", "foo", "x"])).toBe(false);
    expect(canRunInVfs([])).toBe(false);
  });

  it("rejects -exec / xargs (secondary execution killers)", () => {
    expect(canRunInVfs(["cat", "-exec", "rm"])).toBe(false);
    expect(canRunInVfs(["cat", "-execdir", "rm"])).toBe(false);
    expect(canRunInVfs(["cat", "xargs", "rm"])).toBe(false);
  });

  it("respects sticky fallback", () => {
    markVfsFallback("cat");
    expect(canRunInVfs(["cat", "x.txt"])).toBe(false);
    resetVfsState();
    expect(canRunInVfs(["cat", "x.txt"])).toBe(true);
  });
});

async function compareByteIdentical(cmd: string) {
  const bash = await bashRun(cmd, root);
  const vfs = await runInVfs(cmd, { cwd: root, rootDir: root });
  expect(vfs, `VFS refused ${cmd}`).not.toBeNull();
  expect(vfs!.output).toBe(bash.stdout + bash.stderr);
  expect(vfs!.exitCode).toBe(bash.code);
}

describe("cat — byte-identical with bash", () => {
  it("cat a.txt (10 lines + trailing newline)", () => compareByteIdentical(`cat ${fileA}`));
  it("cat b.txt (no trailing newline)", () => compareByteIdentical(`cat ${fileB}`));
  it("cat a.txt b.txt (concatenation)", () => compareByteIdentical(`cat ${fileA} ${fileB}`));
  it("cat missing file → exit 1 + stderr matches", () =>
    compareByteIdentical(`cat ${root}/missing.txt`));
});

describe("head — byte-identical with bash", () => {
  it("head -5 a.txt", () => compareByteIdentical(`head -5 ${fileA}`));
  it("head -n 3 a.txt", () => compareByteIdentical(`head -n 3 ${fileA}`));
  it("head a.txt (default -10)", () => compareByteIdentical(`head ${fileA}`));
  it("head -2 b.txt (no trailing newline)", () => compareByteIdentical(`head -2 ${fileB}`));
});

describe("tail — byte-identical with bash", () => {
  it("tail -3 a.txt", () => compareByteIdentical(`tail -3 ${fileA}`));
  it("tail -n 5 a.txt", () => compareByteIdentical(`tail -n 5 ${fileA}`));
  it("tail b.txt (no trailing newline, default -10)", () => compareByteIdentical(`tail ${fileB}`));
});

describe("printf — byte-identical with bash", () => {
  it('printf "%s\\n" hello', () => compareByteIdentical('printf "%s\\n" hello'));
  it("printf %d %d 1 2", () => compareByteIdentical('printf "%d %d\\n" 1 2'));
  it("printf width %-10s|%s a b", () => compareByteIdentical('printf "%-10s|%s\\n" a b'));
  it("printf no-newline", () => compareByteIdentical('printf "no-newline"'));
});

describe("echo — byte-identical with bash", () => {
  it("echo hello", () => compareByteIdentical("echo hello"));
  it("echo a b c (multi-arg)", () => compareByteIdentical("echo a b c"));
  it('echo "hello world" (quoted, single token)', () => compareByteIdentical('echo "hello world"'));
  it("echo -n no-newline", () => compareByteIdentical("echo -n no-newline"));
});

describe("pwd — byte-identical with bash", () => {
  it("pwd", () => compareByteIdentical("pwd"));
});

describe("true / false — exit codes", () => {
  it("true → exit 0 empty stdout", () => compareByteIdentical("true"));
  it("false → exit 1 empty stdout", () => compareByteIdentical("false"));
});

describe("basename / dirname — byte-identical with bash", () => {
  it("basename /a/b/c.txt", () => compareByteIdentical("basename /a/b/c.txt"));
  it("basename /a/b/c.txt .txt", () => compareByteIdentical("basename /a/b/c.txt .txt"));
  it("dirname /a/b/c.txt", () => compareByteIdentical("dirname /a/b/c.txt"));
  it("dirname a (no slash)", () => compareByteIdentical("dirname a"));
});

describe("telemetry + sticky fallback", () => {
  it("bumps hit counter on success", async () => {
    resetVfsStats();
    await runInVfs(`cat ${fileA}`, { cwd: root, rootDir: root });
    const s = getVfsStats();
    expect(s.hits.cat).toBe(1);
  });

  it("bumps fallback counter + blacklists on throw", async () => {
    resetVfsState();
    resetVfsStats();
    // Unsupported flag triggers a throw inside the handler
    const r = await runInVfs("cat --color a", { cwd: root, rootDir: root });
    expect(r).toBeNull();
    expect(getVfsStats().fallbacks.cat).toBe(1);
    expect(isVfsBlacklisted("cat")).toBe(true);
  });
});

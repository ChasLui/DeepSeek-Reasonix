/** read_file ← ReadDedupState integration: stub on unchanged re-read, full dump otherwise. */

import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools.js";
import { registerFilesystemTools } from "../../src/tools/filesystem.js";
import { ReadDedupState } from "../../src/tools/fs/read-dedup.js";

let root: string;
let file: string;

function newRegistry(dedupEnabled = true): ToolRegistry {
  const r = new ToolRegistry();
  registerFilesystemTools(r, { rootDir: root, dedupEnabled });
  return r;
}

function read(
  reg: ToolRegistry,
  dedup: ReadDedupState | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  return reg.dispatch("read_file", args, { readDedup: dedup });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rf-dedup-"));
  file = join(root, "a.txt");
  writeFileSync(file, "line1\nline2\nline3\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  // delete (not = undefined): assigning undefined to process.env stringifies to "undefined".
  // biome-ignore lint/performance/noDelete: env var must be truly removed, not set to "undefined".
  delete process.env.REASONIX_DEDUP;
});

const STUB = /unchanged since an earlier read/;

describe("unchanged re-read → stub", () => {
  it("second read of an unchanged file returns a stub, not the body", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    const first = await read(reg, dedup, { path: "a.txt" });
    expect(first).toContain("line1");
    const second = await read(reg, dedup, { path: "a.txt" });
    expect(second).toMatch(STUB);
    expect(second).not.toContain("line2");
  });

  it("stub is deterministic — no timestamps / counters", async () => {
    const reg = newRegistry();
    const d1 = new ReadDedupState();
    await read(reg, d1, { path: "a.txt" });
    const stubA = await read(reg, d1, { path: "a.txt" });
    const d2 = new ReadDedupState();
    await read(reg, d2, { path: "a.txt" });
    const stubB = await read(reg, d2, { path: "a.txt" });
    expect(stubA).toBe(stubB);
    expect(stubA).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|T\d/); // no ISO/clock
  });
});

describe("change detection (improves on openwolf)", () => {
  it("same-size content swap → full re-read (content hash differs)", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt" });
    // Same byte length, different content; also restore mtime to defeat mtime-only checks.
    const st = await fs.stat(file);
    writeFileSync(file, "LINE1\nLINE2\nLINE3\n");
    await fs.utimes(file, st.atime, st.mtime);
    const again = await read(reg, dedup, { path: "a.txt" });
    expect(again).not.toMatch(STUB);
    expect(again).toContain("LINE1");
  });
});

describe("symlink retarget → different inode → no stub", () => {
  it("a path repointed to a new file (new inode) re-reads in full", async () => {
    const real1 = join(root, "real1.txt");
    const real2 = join(root, "real2.txt");
    writeFileSync(real1, "first target\n");
    writeFileSync(real2, "second target\n");
    const link = join(root, "link.txt");
    await fs.symlink(real1, link);

    const reg = newRegistry();
    const dedup = new ReadDedupState();
    const first = await read(reg, dedup, { path: "link.txt" });
    expect(first).toContain("first target");

    // Repoint the symlink at a different inode.
    await fs.unlink(link);
    await fs.symlink(real2, link);
    const again = await read(reg, dedup, { path: "link.txt" });
    expect(again).not.toMatch(STUB);
    expect(again).toContain("second target");
  });
});

describe("scope is part of the key", () => {
  it("head:2 then full read do not dedup each other", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt", head: 2 });
    const full = await read(reg, dedup, { path: "a.txt" });
    expect(full).not.toMatch(STUB);
    expect(full).toContain("line3");
  });

  it("scoped re-read stub reports the VIEW's size, not the whole file", async () => {
    const big = join(root, "big.txt");
    writeFileSync(big, Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n"));
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "big.txt", head: 1 });
    const stub = await read(reg, dedup, { path: "big.txt", head: 1 });
    expect(stub).toMatch(STUB);
    // head:1 emits ~3 lines (content + marker), NOT the 50-line whole file.
    expect(stub).not.toMatch(/50-line/);
    expect(stub).toMatch(/[1-9]-line/);
  });
});

describe("force + kill-switches", () => {
  it("force:true re-reads in full and refreshes the entry", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt" });
    const forced = await read(reg, dedup, { path: "a.txt", force: true });
    expect(forced).not.toMatch(STUB);
    expect(forced).toContain("line1");
    // After a forced re-read the entry is refreshed → next plain read stubs again.
    const stub = await read(reg, dedup, { path: "a.txt" });
    expect(stub).toMatch(STUB);
  });

  it("REASONIX_DEDUP=0 disables dedup entirely", async () => {
    process.env.REASONIX_DEDUP = "0";
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt" });
    const second = await read(reg, dedup, { path: "a.txt" });
    expect(second).not.toMatch(STUB);
  });

  it("config dedupEnabled:false disables dedup", async () => {
    const reg = newRegistry(false);
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt" });
    const second = await read(reg, dedup, { path: "a.txt" });
    expect(second).not.toMatch(STUB);
  });

  it("no dedup state in ctx → always full", async () => {
    const reg = newRegistry();
    await read(reg, undefined, { path: "a.txt" });
    const second = await read(reg, undefined, { path: "a.txt" });
    expect(second).toContain("line1");
  });
});

describe("session isolation", () => {
  it("a second session's first read never stubs (no cross-session leak)", async () => {
    const reg = newRegistry();
    const sessionA = new ReadDedupState();
    const sessionB = new ReadDedupState();
    await read(reg, sessionA, { path: "a.txt" });
    const bFirst = await read(reg, sessionB, { path: "a.txt" });
    expect(bFirst).toContain("line1");
    expect(bFirst).not.toMatch(STUB);
  });
});

describe("log-aware invalidation", () => {
  it("after the prior output leaves the active log, re-read is full", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    await read(reg, dedup, { path: "a.txt" });
    dedup.invalidateAll(); // simulates a history fold / heal / shrink
    const again = await read(reg, dedup, { path: "a.txt" });
    expect(again).not.toMatch(STUB);
    expect(again).toContain("line1");
  });
});

describe("concurrency determinism", () => {
  it("two concurrent reads of the same key both dump (neither stubs)", async () => {
    const reg = newRegistry();
    const dedup = new ReadDedupState();
    const [a, b] = await Promise.all([
      read(reg, dedup, { path: "a.txt" }),
      read(reg, dedup, { path: "a.txt" }),
    ]);
    expect(a).toContain("line1");
    expect(b).toContain("line1");
    expect(a).not.toMatch(STUB);
    expect(b).not.toMatch(STUB);
  });
});

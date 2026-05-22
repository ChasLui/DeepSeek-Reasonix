/** Symlink default-deny gate — core safety guarantees. */

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noFollowFlag, resolveAndValidate, writeFileNoFollow } from "../src/tools/fs/gate.js";

let root: string;
let outside: string;

beforeAll(async () => {
  // Resolve to realpath upfront so macOS /var vs /private/var doesn't trip the test.
  root = await fs.realpath(mkdtempSync(join(tmpdir(), "gate-root-")));
  outside = await fs.realpath(mkdtempSync(join(tmpdir(), "gate-outside-")));
  await fs.writeFile(join(outside, "secret.txt"), "leaked");
  await fs.writeFile(join(root, "ok.txt"), "good");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveAndValidate", () => {
  it("accepts a regular file inside root", async () => {
    const result = await resolveAndValidate(join(root, "ok.txt"), root);
    expect(result).toBe(join(root, "ok.txt"));
  });

  it("rejects a symlink pointing outside root (default deny)", async () => {
    const link = join(root, "leak");
    await fs.symlink(join(outside, "secret.txt"), link);
    await expect(resolveAndValidate(link, root)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("allows a symlink when allowSymlinks: true (escape hatch)", async () => {
    const link = join(root, "leak2");
    await fs.symlink(join(outside, "secret.txt"), link);
    const result = await resolveAndValidate(link, root, {
      allowSymlinks: true,
    });
    expect(result).toBe(join(outside, "secret.txt"));
  });

  it("rejects a symlink whose parent dir escapes root", async () => {
    const linkedDir = join(root, "via");
    await fs.symlink(outside, linkedDir).catch(() => {}); // OK if already exists
    await expect(resolveAndValidate(join(linkedDir, "secret.txt"), root)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("accepts a not-yet-existing file under root (new-file write path)", async () => {
    const result = await resolveAndValidate(join(root, "new.txt"), root);
    expect(result).toBe(join(root, "new.txt"));
  });
});

describe("writeFileNoFollow (TOCTOU defense)", () => {
  it("creates a new file inside root", async () => {
    const dest = join(root, "fresh.txt");
    await writeFileNoFollow(dest, "hello");
    expect(await fs.readFile(dest, "utf8")).toBe("hello");
  });

  it("overwrites a regular file in place", async () => {
    const dest = join(root, "ok.txt");
    await writeFileNoFollow(dest, "rewritten");
    expect(await fs.readFile(dest, "utf8")).toBe("rewritten");
  });

  it("refuses to write through a symlink (POSIX O_NOFOLLOW)", async () => {
    if (noFollowFlag() === undefined) return;
    const dest = join(root, "target.txt");
    await fs.writeFile(dest, "original");
    const link = join(root, "via-link");
    await fs.symlink(dest, link).catch(() => {});
    await expect(writeFileNoFollow(link, "leaked")).rejects.toThrow();
    expect(await fs.readFile(dest, "utf8")).toBe("original");
  });

  it("TOCTOU swap: gate validates then file is swapped for symlink, O_NOFOLLOW refuses", async () => {
    if (noFollowFlag() === undefined) return;
    const dest = join(root, "toctou.txt");
    const outsideTarget = join(outside, "secret.txt");
    await fs.writeFile(dest, "init");
    const validated = await resolveAndValidate(dest, root);
    expect(validated).toBe(dest);
    await fs.unlink(dest);
    await fs.symlink(outsideTarget, dest);
    await expect(writeFileNoFollow(dest, "would-leak")).rejects.toThrow();
    expect(await fs.readFile(outsideTarget, "utf8")).toBe("leaked");
  });
});

describe("noFollowFlag platform shape", () => {
  it("returns a numeric POSIX flag on macOS/Linux, undefined on Windows", () => {
    if (process.platform === "win32") {
      expect(noFollowFlag()).toBeUndefined();
    } else {
      expect(typeof noFollowFlag()).toBe("number");
    }
  });
});

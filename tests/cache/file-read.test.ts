import { promises as fsPromises } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileReadCache } from "../../src/cache/file-read.js";
import { ParseTreeCache, parseSource } from "../../src/code-query/parser.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerFilesystemTools } from "../../src/tools/filesystem.js";

describe("FileReadCache", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "reasonix-file-cache-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("hits only when path, mtime, and size match", () => {
    const cache = new FileReadCache();
    const stat = { mtimeMs: 1, size: 5 };
    cache.set("/tmp/a.ts", stat, Buffer.from("alpha"), "sha-a", "utf8");

    expect(cache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("alpha");
    expect(cache.get("/tmp/a.ts", { mtimeMs: 2, size: 5 })).toBeNull();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("uses inode and ctime when the caller provides stronger identity", () => {
    const cache = new FileReadCache();
    const stat = { dev: 1, ino: 10, mtimeMs: 1, ctimeMs: 2, size: 5 };
    cache.set("/tmp/a.ts", stat, Buffer.from("alpha"), "sha-a", "utf8");

    expect(cache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("alpha");
    expect(cache.get("/tmp/a.ts", { ...stat, ctimeMs: 3 })).toBeNull();
    expect(cache.get("/tmp/a.ts", { ...stat, ino: 11 })).toBeNull();
  });

  it("evicts by LRU under the byte cap and skips oversized single entries", () => {
    const cache = new FileReadCache({ maxSizeBytes: 10, entrySizeLimitBytes: 100 });
    cache.set("/tmp/a.ts", { mtimeMs: 1, size: 6 }, Buffer.from("123456"), "a", "utf8");
    cache.set("/tmp/b.ts", { mtimeMs: 1, size: 6 }, Buffer.from("abcdef"), "b", "utf8");

    expect(cache.get("/tmp/a.ts", { mtimeMs: 1, size: 6 })).toBeNull();
    expect(cache.get("/tmp/b.ts", { mtimeMs: 1, size: 6 })?.sha256).toBe("b");
    expect(cache.stats().evictions).toBe(1);

    const smallLimit = new FileReadCache({ entrySizeLimitBytes: 4 });
    smallLimit.set("/tmp/c.ts", { mtimeMs: 1, size: 5 }, Buffer.from("12345"), "c", "utf8");
    expect(smallLimit.get("/tmp/c.ts", { mtimeMs: 1, size: 5 })).toBeNull();
  });

  it("keeps instances isolated even for identical keys", () => {
    const stat = { mtimeMs: 1, size: 5 };
    const a = new FileReadCache();
    const b = new FileReadCache();

    a.set("/tmp/a.ts", stat, Buffer.from("alpha"), "sha-a", "utf8");
    b.set("/tmp/a.ts", stat, Buffer.from("bravo"), "sha-b", "utf8");

    expect(a.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("alpha");
    expect(b.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("bravo");
  });

  it("lets edit_file reuse raw bytes written by read_file", async () => {
    await fs.writeFile(join(root, "a.txt"), "alpha\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();
    const parseCache = new ParseTreeCache();

    await registry.dispatch("read_file", { path: "a.txt" }, { fileCache, parseCache });
    const out = await registry.dispatch(
      "edit_file",
      { path: "a.txt", search: "alpha", replace: "bravo" },
      { fileCache, parseCache },
    );

    expect(out).toContain("edited a.txt");
    expect(fileCache.stats().hits).toBe(1);
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("bravo\n");
  });

  it("does not let an equal-size external rewrite reuse stale raw bytes", async () => {
    const file = join(root, "a.txt");
    await fs.writeFile(file, "alpha\n");
    const initial = await fs.stat(file);
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();

    await registry.dispatch("read_file", { path: "a.txt" }, { fileCache });
    await fs.writeFile(file, "bravo\n");
    await fs.utimes(file, initial.atime, initial.mtime);
    const out = await registry.dispatch(
      "edit_file",
      { path: "a.txt", search: "bravo", replace: "charl" },
      { fileCache },
    );

    expect(out).toContain("edited a.txt");
    expect(await fs.readFile(file, "utf8")).toBe("charl\n");
    expect(fileCache.stats().misses).toBeGreaterThanOrEqual(1);
  });

  it("skips the edit_file fs.readFile fallback after read_file warmed the cache", async () => {
    await fs.writeFile(join(root, "a.txt"), "alpha\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();
    const readFileSpy = vi.spyOn(fsPromises, "readFile");

    await registry.dispatch("read_file", { path: "a.txt" }, { fileCache });
    await registry.dispatch(
      "edit_file",
      { path: "a.txt", search: "alpha", replace: "bravo" },
      { fileCache },
    );

    expect(readFileSpy).not.toHaveBeenCalled();
    expect(fileCache.stats().hits).toBe(1);
  });

  it("invalidates file and parse caches after a successful edit", async () => {
    await fs.writeFile(join(root, "a.ts"), "function alpha() {}\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();
    const parseCache = new ParseTreeCache();
    const parsed = await parseSource(join(root, "a.ts"), "function alpha() {}\n");
    parseCache.set(
      { absPath: join(root, "a.ts"), mtimeMs: 1, size: 20, shaPrefix: "old" },
      parsed!.tree,
    );
    parsed!.tree.delete();

    await registry.dispatch("read_file", { path: "a.ts" }, { fileCache, parseCache });
    await registry.dispatch(
      "edit_file",
      { path: "a.ts", search: "alpha", replace: "bravo" },
      { fileCache, parseCache },
    );
    const out = await registry.dispatch("read_file", { path: "a.ts" }, { fileCache, parseCache });

    expect(out).toContain("function bravo");
    expect(fileCache.stats().entries).toBe(1);
    expect(parseCache.stats().entries).toBe(0);
  });

  it("invalidates file and parse caches after write_file", async () => {
    await fs.writeFile(join(root, "a.ts"), "function alpha() {}\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();
    const parseCache = new ParseTreeCache();
    const parsed = await parseSource(join(root, "a.ts"), "function alpha() {}\n");
    parseCache.set(
      { absPath: join(root, "a.ts"), mtimeMs: 1, size: 20, shaPrefix: "old" },
      parsed!.tree,
    );
    parsed!.tree.delete();

    await registry.dispatch("read_file", { path: "a.ts" }, { fileCache, parseCache });
    expect(fileCache.stats().entries).toBe(1);
    expect(parseCache.stats().entries).toBe(1);

    await registry.dispatch(
      "write_file",
      { path: "a.ts", content: "function bravo() {}\n" },
      { fileCache, parseCache },
    );

    expect(fileCache.stats().entries).toBe(0);
    expect(parseCache.stats().entries).toBe(0);
  });

  it("short-circuits off when REASONIX_FILE_CACHE=0", async () => {
    vi.stubEnv("REASONIX_FILE_CACHE", "0");
    await fs.writeFile(join(root, "a.txt"), "alpha\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();

    await registry.dispatch("read_file", { path: "a.txt" }, { fileCache });
    await registry.dispatch(
      "edit_file",
      { path: "a.txt", search: "alpha", replace: "bravo" },
      { fileCache },
    );

    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("bravo\n");
    expect(fileCache.stats()).toEqual({
      hits: 0,
      misses: 0,
      evictions: 0,
      sizeBytes: 0,
      entries: 0,
    });
  });

  it("uses the edit_file fs.readFile fallback when REASONIX_FILE_CACHE=0", async () => {
    vi.stubEnv("REASONIX_FILE_CACHE", "0");
    await fs.writeFile(join(root, "a.txt"), "alpha\n");
    const registry = filesystemRegistry(root);
    const fileCache = new FileReadCache();
    const readFileSpy = vi.spyOn(fsPromises, "readFile");

    await registry.dispatch("read_file", { path: "a.txt" }, { fileCache });
    await registry.dispatch(
      "edit_file",
      { path: "a.txt", search: "alpha", replace: "bravo" },
      { fileCache },
    );

    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("bravo\n");
  });
});

function filesystemRegistry(root: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry, { rootDir: root });
  return registry;
}

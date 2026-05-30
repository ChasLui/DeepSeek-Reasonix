import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteMemoryStore } from "../../src/adapters/memory-store-sqlite.js";
import { memoryStats, rebuildMemoryIndex, searchMemory } from "../../src/cli/commands/memory.js";
import { openMemoryStore } from "../../src/memory/user.js";
import { resetDb } from "../../src/storage/db.js";

// SQLite-only: the CLI helpers + the seed store share getDb(), resolved from $HOME — so
// stub HOME to the tmp home and reset the db singleton each test for isolation.
describe("memory hybrid search CLI helpers", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-memory-cli-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-memory-cli-project-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    resetDb();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("rebuilds a lexical memory index", async () => {
    seedMemory(home, projectRoot);

    const result = await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: async () => new Float32Array([1, 0]),
    });

    expect(result.lexicalDocs).toBe(3);
    expect(existsSync(join(home, "memory", ".index", "lexical.json"))).toBe(true);
    expect(readFileSync(join(home, "memory", ".index", ".stale"), "utf8").trim()).toBe("false");
  });

  it("marks the rebuilt index stale after memory writes and deletes", async () => {
    const store = seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });
    expect(memoryStats({ homeDir: home, projectRoot }).lexicalStale).toBe(false);

    store.write({
      name: "new_fact",
      type: "project",
      scope: "global",
      description: "new fact",
      body: "body",
    });
    expect(memoryStats({ homeDir: home, projectRoot }).lexicalStale).toBe(true);

    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });
    expect(memoryStats({ homeDir: home, projectRoot }).lexicalStale).toBe(false);
    store.delete("global", "new_fact");
    expect(memoryStats({ homeDir: home, projectRoot }).lexicalStale).toBe(true);
  });

  it("searches lexical-only by default", async () => {
    seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });

    const result = await searchMemory("prompt cache 漂移", {
      homeDir: home,
      projectRoot,
    });

    expect(result.mode).toBe("lexical-only");
    expect(result.hits[0]?.entry.name).toBe("prompt_cache");
  });

  it("uses RRF when hybrid is explicitly enabled", async () => {
    seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });

    const result = await searchMemory("unrelated vector should find semantic", {
      homeDir: home,
      projectRoot,
      hybrid: true,
      embedText: async () => new Float32Array([0, 1]),
    });

    expect(result.mode).toBe("hybrid");
    expect(result.hits.map((hit) => hit.entry.name)).toContain("semantic_only");
  });

  it("REASONIX_HYBRID_SEARCH=0 forces lexical-only", async () => {
    seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });
    vi.stubEnv("REASONIX_HYBRID_SEARCH", "0");

    const result = await searchMemory("semantic", {
      homeDir: home,
      projectRoot,
      hybrid: true,
      embedText: async () => new Float32Array([0, 1]),
    });

    expect(result.mode).toBe("lexical-only");
  });

  it("records access sidecar events for search hits", async () => {
    seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });

    await searchMemory("prompt cache", { homeDir: home, projectRoot, topK: 1 });

    expect(readFileSync(join(home, "memory", ".access.jsonl"), "utf8")).toContain(
      '"name":"prompt_cache"',
    );
  });

  it("reports stats without loading code semantic index", async () => {
    seedMemory(home, projectRoot);
    await rebuildMemoryIndex({
      homeDir: home,
      projectRoot,
      embedText: vectorForText,
    });

    const stats = memoryStats({ homeDir: home, projectRoot });

    expect(stats.entries).toBe(3);
    expect(stats.lexicalDocs).toBe(3);
    expect(stats.semanticExists).toBe(true);
    expect(stats.observations24h).toBe(0);
  });
});

function seedMemory(home: string, projectRoot: string): SqliteMemoryStore {
  const store = openMemoryStore({ homeDir: home, projectRoot });
  store.write({
    name: "prompt_cache",
    type: "project",
    scope: "global",
    description: "prompt cache 漂移处理",
    body: "检查 prefix fingerprint 和 append-only log。",
  });
  store.write({
    name: "tool_repair",
    type: "project",
    scope: "global",
    description: "tool repair pipeline",
    body: "flatten scavenge truncation storm",
  });
  store.write({
    name: "semantic_only",
    type: "project",
    scope: "global",
    description: "vector-only entry",
    body: "This entry is found through the injected semantic vector.",
  });
  return store;
}

async function vectorForText(text: string): Promise<Float32Array> {
  return text.includes("vector-only") || text.includes("semantic vector")
    ? new Float32Array([0, 1])
    : new Float32Array([1, 0]);
}

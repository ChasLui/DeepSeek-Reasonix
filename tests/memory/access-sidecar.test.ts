import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAccess,
  computeDecayScore,
  forget,
  loadAccessStats,
  purge,
} from "../../src/memory/access.js";
import { MemoryStore } from "../../src/memory/user.js";

describe("memory access sidecar", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-access-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-access-project-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("appends access events without touching markdown files", () => {
    const store = new MemoryStore({ homeDir: home });
    const file = store.write({
      name: "cache_rule",
      type: "project",
      scope: "global",
      description: "Cache rule",
      body: "Keep the prefix append-only.",
    });
    const before = statSync(file).mtimeMs;

    appendAccess("global", "cache_rule", new Date("2026-05-01T00:00:00Z"), { homeDir: home });

    expect(readFileSync(file, "utf8")).toContain("Keep the prefix append-only.");
    expect(statSync(file).mtimeMs).toBe(before);
    expect(readFileSync(join(home, "memory", ".access.jsonl"), "utf8")).toContain(
      '"name":"cache_rule"',
    );
  });

  it("loads access stats from append-only jsonl", () => {
    appendAccess("global", "cache_rule", new Date("2026-05-01T00:00:00Z"), { homeDir: home });
    appendAccess("global", "cache_rule", new Date("2026-05-03T00:00:00Z"), { homeDir: home });

    const stats = loadAccessStats({ homeDir: home });

    expect(stats.get("global/cache_rule")).toEqual({
      lastAccessedAt: "2026-05-03T00:00:00.000Z",
      accessCount: 2,
    });
  });

  it("skips malformed sidecar lines with a warning", () => {
    const root = join(home, "memory");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".access.jsonl"), '{"bad":true}\nnot-json\n', {
      encoding: "utf8",
      flag: "w",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadAccessStats({ homeDir: home }).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("computes decay with priority separation for old unaccessed entries", () => {
    const now = new Date("2026-05-31T00:00:00Z");
    const low = computeDecayScore(
      {
        name: "low_mem",
        type: "project",
        scope: "global",
        description: "low",
        body: "body",
        createdAt: "2026-05-01",
        priority: "low",
      },
      undefined,
      now,
    );
    const high = computeDecayScore(
      {
        name: "high_mem",
        type: "project",
        scope: "global",
        description: "high",
        body: "body",
        createdAt: "2026-05-01",
        priority: "high",
      },
      undefined,
      now,
    );

    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(1.5);
  });

  it("raises the decay score for frequently accessed entries", () => {
    const entry = {
      name: "cache_rule",
      type: "project",
      scope: "global",
      description: "Cache rule",
      body: "Body",
      createdAt: "2026-05-01",
      priority: "low",
    } as const;
    const now = new Date("2026-05-31T00:00:00Z");

    expect(
      computeDecayScore(
        entry,
        { lastAccessedAt: "2026-05-30T00:00:00.000Z", accessCount: 10 },
        now,
      ),
    ).toBeGreaterThan(computeDecayScore(entry, undefined, now));
  });

  it("previews forget candidates by default", () => {
    const store = new MemoryStore({ homeDir: home });
    store.write({
      name: "old_low",
      type: "project",
      scope: "global",
      description: "Old low priority",
      body: "Body",
      priority: "low",
    });

    const result = forget(store, {
      minScore: 0.5,
      now: new Date("2026-06-30T00:00:00Z"),
    });

    expect(result.previewed).toBe(1);
    expect(result.softDeleted).toBe(0);
    expect(store.list().map((entry) => entry.name)).toEqual(["old_low"]);
  });

  it("soft-deletes forget candidates into trash when apply is set", () => {
    const store = new MemoryStore({ homeDir: home });
    store.write({
      name: "old_low",
      type: "project",
      scope: "global",
      description: "Old low priority",
      body: "Body",
      priority: "low",
    });

    const result = forget(store, {
      minScore: 0.5,
      dryRun: false,
      now: new Date("2026-06-30T00:00:00Z"),
    });

    expect(result.softDeleted).toBe(1);
    expect(store.list()).toEqual([]);
    const trash = readdirSync(join(home, "memory", ".trash"));
    expect(trash).toHaveLength(1);
    expect(readFileSync(join(home, "memory", ".trash", trash[0]!), "utf8")).toContain("old_low");
  });

  it("purges trash unless CI guard is active", () => {
    const store = new MemoryStore({ homeDir: home });
    const trash = join(home, "memory", ".trash");
    mkdirSync(trash, { recursive: true });
    writeFileSync(join(trash, "20260501000000-old_low.md"), "body", {
      encoding: "utf8",
      flag: "w",
    });
    vi.stubEnv("CI", "true");

    expect(() => purge(store)).toThrow(/CI=true/);
    expect(existsSync(join(trash, "20260501000000-old_low.md"))).toBe(true);

    vi.stubEnv("CI", "false");
    expect(purge(store).hardDeleted).toBe(1);
    expect(readdirSync(trash)).toEqual([]);
  });

  it("handles multiple appenders without losing lines", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          appendAccess("global", "cache_rule", new Date(2026, 4, 1, 0, 0, i), { homeDir: home }),
        ),
      ),
    );

    expect(loadAccessStats({ homeDir: home }).get("global/cache_rule")?.accessCount).toBe(20);
  });
});

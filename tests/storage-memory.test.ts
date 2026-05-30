import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "../src/adapters/memory-store-sqlite.js";
import { getDb, resetDb } from "../src/storage/db.js";

function tmp(): { home: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-mem-"));
  return { home: dir, db: join(dir, "reasonix.db") };
}

const ENTRIES = [
  {
    name: "auth-flow",
    type: "user" as const,
    scope: "global" as const,
    description: "OAuth2 token\nrefresh cycle",
    body: "step 1\nstep 2",
  },
  {
    name: "build-paths",
    type: "reference" as const,
    scope: "global" as const,
    description: "where artifacts live",
    body: "dist/",
  },
  {
    name: "abc",
    type: "user" as const,
    scope: "global" as const,
    description: "short",
    body: "b",
  },
];

afterEach(() => resetDb());

describe("storage/memory-store-sqlite", () => {
  it("loadIndexContent single-lines descriptions and sorts by `${name}.md` (SC-003)", () => {
    const store = new SqliteMemoryStore(getDb(tmp().db));
    for (const e of ENTRIES) store.write(e);
    const idx = store.loadIndexContent("global");
    // Sorted by `${name}.md` localeCompare: abc, auth-flow, build-paths.
    // Newlines in `description` collapse to spaces (prefix byte-stability).
    expect(idx?.content).toBe(
      [
        "- [abc](abc.md) — short",
        "- [auth-flow](auth-flow.md) — OAuth2 token refresh cycle",
        "- [build-paths](build-paths.md) — where artifacts live",
      ].join("\n"),
    );
    expect(idx?.truncated).toBe(false);
  });

  it("loadIndexContent is insertion-order-independent", () => {
    const a = new SqliteMemoryStore(getDb(tmp().db));
    for (const e of ENTRIES) a.write(e);
    const forward = a.loadIndexContent("global");
    resetDb();
    const b = new SqliteMemoryStore(getDb(tmp().db));
    for (const e of [...ENTRIES].reverse()) b.write(e);
    expect(b.loadIndexContent("global")).toEqual(forward);
  });

  it("round-trips a memory and removes it", () => {
    const store = new SqliteMemoryStore(getDb(tmp().db));
    store.write(ENTRIES[0]);
    expect(store.query("global", "auth-flow")).toMatchObject({
      name: "auth-flow",
      description: "OAuth2 token\nrefresh cycle",
      body: "step 1\nstep 2",
    });
    expect(store.list().length).toBe(1);
    expect(store.remove("global", "auth-flow")).toBe(true);
    expect(store.query("global", "auth-flow")).toBeNull();
  });

  it("write preserves priority and expires (HIGH PRIORITY block depends on it)", () => {
    const store = new SqliteMemoryStore(getDb(tmp().db));
    store.write({
      name: "hard-rule",
      type: "feedback",
      scope: "global",
      description: "always tabs",
      body: "no spaces",
      priority: "high",
      expires: "project_end",
    });
    expect(store.query("global", "hard-rule")).toMatchObject({
      priority: "high",
      expires: "project_end",
    });
  });

  it("isolates same-named memory across projects (FR-019 PK)", () => {
    const db = getDb(tmp().db);
    const projA = new SqliteMemoryStore(db, "/tmp/projA");
    const projB = new SqliteMemoryStore(db, "/tmp/projB");
    projA.write({
      name: "shared",
      type: "project",
      scope: "project",
      description: "A",
      body: "a",
    });
    projB.write({
      name: "shared",
      type: "project",
      scope: "project",
      description: "B",
      body: "b",
    });
    expect(projA.query("project", "shared")?.description).toBe("A");
    expect(projB.query("project", "shared")?.description).toBe("B");
  });

  it("exportMarkdown single-lines the frontmatter description + keeps priority (FR-021)", () => {
    const store = new SqliteMemoryStore(getDb(tmp().db));
    store.write({
      name: "auth-flow",
      type: "user",
      scope: "global",
      description: "OAuth2 token\nrefresh cycle",
      body: "step 1\nstep 2",
      priority: "high",
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(store.exportMarkdown("global", "auth-flow")).toBe(
      [
        "---",
        "name: auth-flow",
        "description: OAuth2 token refresh cycle",
        "type: user",
        "scope: global",
        `created: ${today}`,
        "priority: high",
        "---",
        "step 1\nstep 2",
        "",
      ].join("\n"),
    );
  });
});

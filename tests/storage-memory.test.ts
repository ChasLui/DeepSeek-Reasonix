import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "../src/adapters/memory-store-sqlite.js";
import { MemoryStore } from "../src/memory/user.js";
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
  it("loadIndexContent is byte-identical to the file backend's loadIndex (SC-003)", async () => {
    const { home, db: dbPath } = tmp();
    const fileStore = new MemoryStore({ homeDir: home });
    const sqlStore = new SqliteMemoryStore(getDb(dbPath));
    for (const e of ENTRIES) {
      fileStore.write(e);
      await sqlStore.write(e);
    }
    expect(sqlStore.loadIndexContent("global")).toEqual(fileStore.loadIndex("global"));
  });

  it("round-trips through the MemoryStore port", async () => {
    const store = new SqliteMemoryStore(getDb(tmp().db));
    await store.write(ENTRIES[0]);
    expect(await store.query("global", "auth-flow")).toMatchObject({
      name: "auth-flow",
      description: "OAuth2 token\nrefresh cycle",
      body: "step 1\nstep 2",
    });
    expect((await store.list("global")).length).toBe(1);
    expect(await store.remove("global", "auth-flow")).toBe(true);
    expect(await store.query("global", "auth-flow")).toBeNull();
  });

  it("isolates same-named memory across projects (FR-019 PK)", async () => {
    const db = getDb(tmp().db);
    const projA = new SqliteMemoryStore(db, "/tmp/projA");
    const projB = new SqliteMemoryStore(db, "/tmp/projB");
    await projA.write({
      name: "shared",
      type: "project",
      scope: "project",
      description: "A",
      body: "a",
    });
    await projB.write({
      name: "shared",
      type: "project",
      scope: "project",
      description: "B",
      body: "b",
    });
    expect((await projA.query("project", "shared"))?.description).toBe("A");
    expect((await projB.query("project", "shared"))?.description).toBe("B");
  });

  it("exportMarkdown reproduces the file backend's Markdown (FR-021)", async () => {
    const { home, db: dbPath } = tmp();
    const fileStore = new MemoryStore({ homeDir: home });
    const sqlStore = new SqliteMemoryStore(getDb(dbPath));
    fileStore.write(ENTRIES[0]);
    await sqlStore.write(ENTRIES[0]);
    const fileMd = readFileSync(fileStore.pathFor("global", "auth-flow"), "utf8");
    expect(sqlStore.exportMarkdown("global", "auth-flow")).toBe(fileMd);
  });
});

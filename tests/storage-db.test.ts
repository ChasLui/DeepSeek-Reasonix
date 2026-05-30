import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../src/storage/db.js";
import { appliedVersions, migrate } from "../src/storage/schema.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-db-")), "reasonix.db");
}

afterEach(() => resetDb());

describe("storage/db", () => {
  it("opens a db, enables WAL, and is idempotent on re-migrate (SC-004)", () => {
    const path = tmpDbPath();
    const db1 = getDb(path);
    expect(db1.journalMode).toBe("wal");
    expect(existsSync(path)).toBe(true);
    const before = appliedVersions(db1);
    migrate(db1);
    expect(appliedVersions(db1)).toEqual(before);
    const count1 = Number(db1.prepare("SELECT count(*) c FROM schema_migrations").get()?.c);

    resetDb();
    const db2 = getDb(path);
    const count2 = Number(db2.prepare("SELECT count(*) c FROM schema_migrations").get()?.c);
    expect(count2).toBe(count1);
  });

  it("schema_migrations ledger has the FR-004 shape", () => {
    const db = getDb(tmpDbPath());
    const cols = db
      .prepare("PRAGMA table_info(schema_migrations)")
      .all()
      .map((r) => String(r.name));
    expect(cols).toEqual(["version", "name", "applied_at"]);
  });

  it("getDb is a singleton; resetDb releases it", () => {
    const a = getDb(tmpDbPath());
    expect(getDb()).toBe(a);
    resetDb();
    expect(getDb(tmpDbPath())).not.toBe(a);
  });

  it("prepare memoizes statements", () => {
    const db = getDb(tmpDbPath());
    const s1 = db.prepare("SELECT 1 AS x");
    expect(db.prepare("SELECT 1 AS x")).toBe(s1);
    expect(s1.get()).toEqual({ x: 1 });
  });

  it("tx commits on success and rolls back on throw", () => {
    const db = getDb(tmpDbPath());
    db.exec("CREATE TABLE t (v INTEGER)");
    db.tx(() => db.prepare("INSERT INTO t VALUES (?)").run(1));
    expect(Number(db.prepare("SELECT count(*) c FROM t").get()?.c)).toBe(1);
    expect(() =>
      db.tx(() => {
        db.prepare("INSERT INTO t VALUES (?)").run(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(Number(db.prepare("SELECT count(*) c FROM t").get()?.c)).toBe(1);
  });

  it("withBusyRetry returns the result and rethrows non-busy errors", () => {
    const db = getDb(tmpDbPath());
    expect(db.withBusyRetry(() => 42)).toBe(42);
    expect(() =>
      db.withBusyRetry(() => {
        throw new Error("near FROM: syntax error");
      }),
    ).toThrow("syntax error");
  });
});

describe("node:sqlite isolation (SC-008 / NF-004)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("only src/storage/db.ts imports node:sqlite (SC-008)", () => {
    const offenders = walk(srcDir)
      .filter((f) => readFileSync(f, "utf8").includes("node:sqlite"))
      .map((f) => f.slice(srcDir.length + 1));
    expect(offenders).toEqual(["storage/db.ts"]);
  });

  it("only one `new DatabaseSync` site (NF-004 single instance)", () => {
    const sites = walk(srcDir)
      .filter((f) => /new DatabaseSync/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(srcDir.length + 1));
    expect(sites).toEqual(["storage/db.ts"]);
  });
});

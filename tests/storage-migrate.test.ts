import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../src/storage/db.js";
import { migrateStore } from "../src/storage/migrate-store.js";
import { storeBackend } from "../src/storage/select.js";

afterEach(() => resetDb());

// Builds a `~/.reasonix`-shaped home with one of every source artifact, returns
// its path. Each subsystem gets just enough rows to prove the copy ran.
function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "reasonix-migrate-"));
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });

  writeFileSync(
    join(home, "usage.jsonl"),
    `${JSON.stringify({ ts: 1700000000000, session: "sess1", model: "deepseek-chat", promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10, costUsd: 0.01, claudeEquivUsd: 0.05 })}\n${JSON.stringify({ ts: 1700000001000, session: "sess1", model: "deepseek-chat", promptTokens: 20, completionTokens: 8, cacheHitTokens: 5, cacheMissTokens: 15, costUsd: 0.02, claudeEquivUsd: 0.08 })}\n`,
  );

  writeFileSync(
    join(sessions, "sess1.jsonl"),
    `${JSON.stringify({ role: "user", content: "hi" })}\n${JSON.stringify({ role: "assistant", content: "yo" })}\n`,
  );
  writeFileSync(
    join(sessions, "sess1.meta.json"),
    JSON.stringify({ branch: "main", turnCount: 1, summary: "s" }),
  );
  writeFileSync(
    join(sessions, "sess1.events.jsonl"),
    `${JSON.stringify({ type: "user.message", ts: "2026-01-01T00:00:00.000Z", turn: 0 })}\n${JSON.stringify({ type: "model.final", ts: "2026-01-01T00:00:01.000Z", turn: 0 })}\n`,
  );

  const memGlobal = join(home, "memory", "global");
  mkdirSync(memGlobal, { recursive: true });
  writeFileSync(
    join(memGlobal, "foo.md"),
    "---\nname: foo\ntype: project\nscope: global\ndescription: a global memory\ncreated: 2026-01-01\n---\nthe body\n",
  );

  // A project-scoped memory dir, named by its project_hash (NOT "global"). Proves
  // migrate enumerates every project's memory, not just the cwd one.
  const memProject = join(home, "memory", "abc123def4560000");
  mkdirSync(memProject, { recursive: true });
  writeFileSync(
    join(memProject, "bar.md"),
    "---\nname: bar\ntype: project\nscope: project\ndescription: a project memory\ncreated: 2026-02-02\n---\nproject body\n",
  );

  return home;
}

function dbFor(home: string) {
  return getDb(join(home, "reasonix.db"));
}

const count = (db: ReturnType<typeof getDb>, sql: string): number =>
  Number((db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0);

describe("storage/migrate-store", () => {
  it("copies every subsystem into SQLite and records the ledger", () => {
    const home = seedHome();
    const db = dbFor(home);
    const result = migrateStore({ homeDir: home, db });

    expect(count(db, "SELECT count(*) c FROM usage")).toBe(2);
    expect(count(db, "SELECT count(*) c FROM session_messages WHERE session='sess1'")).toBe(2);
    expect(count(db, "SELECT count(*) c FROM events WHERE session='sess1'")).toBe(2);
    expect(count(db, "SELECT count(*) c FROM memory WHERE scope='global'")).toBe(1);
    // The project-hash dir migrated under its own project_hash (every project, not cwd).
    expect(
      count(
        db,
        "SELECT count(*) c FROM memory WHERE scope='project' AND project_hash='abc123def4560000'",
      ),
    ).toBe(1);

    const meta = db.prepare("SELECT branch, summary FROM sessions WHERE name='sess1'").get() as {
      branch: string;
      summary: string;
    };
    expect(meta.branch).toBe("main");
    expect(count(db, "SELECT count(*) c FROM migration_state")).toBe(4);
    expect(result.subsystems.every((s) => !s.skipped)).toBe(true);
    expect(result.activated).toBe(false); // copy-only by default
  });

  it("preserves the source memory created_at (importEntry, not write())", () => {
    const home = seedHome();
    const db = dbFor(home);
    migrateStore({ homeDir: home, db });
    const row = db.prepare("SELECT created_at FROM memory WHERE name='foo'").get() as {
      created_at: string;
    };
    expect(row.created_at).toBe("2026-01-01");
  });

  it("is idempotent — a second run skips every already-migrated subsystem", () => {
    const home = seedHome();
    const db = dbFor(home);
    migrateStore({ homeDir: home, db });
    const second = migrateStore({ homeDir: home, db });
    expect(second.subsystems.every((s) => s.skipped)).toBe(true);
    // No double-import.
    expect(count(db, "SELECT count(*) c FROM usage")).toBe(2);
    expect(count(db, "SELECT count(*) c FROM session_messages WHERE session='sess1'")).toBe(2);
  });

  it("activate flips .store-version to sqlite", () => {
    const home = seedHome();
    const db = dbFor(home);
    expect(storeBackend(home)).toBe("jsonl");
    const result = migrateStore({ homeDir: home, db, activate: true });
    expect(result.activated).toBe(true);
    expect(storeBackend(home)).toBe("sqlite");
  });

  it("dryRun counts source records without writing or recording", () => {
    const home = seedHome();
    const db = dbFor(home);
    const result = migrateStore({ homeDir: home, db, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(count(db, "SELECT count(*) c FROM usage")).toBe(0);
    expect(count(db, "SELECT count(*) c FROM migration_state")).toBe(0);
    // sessions count = number of session logs; usage/events/memory = rows.
    const bySub = new Map(result.subsystems.map((s) => [s.name, s.count]));
    expect(bySub.get("usage")).toBe(2);
    expect(bySub.get("sessions")).toBe(1);
    expect(bySub.get("events")).toBe(2);
    expect(bySub.get("memory")).toBe(2); // foo (global) + bar (project)
  });

  it("only-filter restricts the run to named subsystems", () => {
    const home = seedHome();
    const db = dbFor(home);
    migrateStore({ homeDir: home, db, only: ["usage"] });
    expect(count(db, "SELECT count(*) c FROM usage")).toBe(2);
    expect(count(db, "SELECT count(*) c FROM session_messages")).toBe(0);
    expect(count(db, "SELECT count(*) c FROM migration_state")).toBe(1);
  });
});

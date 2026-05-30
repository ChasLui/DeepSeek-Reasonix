import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../src/memory/session.js";
import { getDb, resetDb } from "../src/storage/db.js";
import {
  appendSessionMessageDb,
  listSessionMetaDb,
  loadSessionMetaDb,
  upsertSessionMeta,
} from "../src/storage/sessions-repo.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-meta-")), "reasonix.db");
}

afterEach(() => resetDb());

const FULL: SessionMeta = {
  branch: "main",
  summary: "a session",
  totalCostUsd: 1.23,
  turnCount: 7,
  workspace: "/work/x",
  balanceCurrency: "USD",
  cacheHitTokens: 100,
  cacheMissTokens: 50,
  lastPromptTokens: 200,
  autoTitleGenerated: true,
  source: "claude-code",
};

describe("storage/sessions-repo meta", () => {
  it("round-trips a full SessionMeta", () => {
    const db = getDb(tmpPath());
    upsertSessionMeta(db, "s1", FULL, "2026-01-01T00:00:00.000Z");
    expect(loadSessionMetaDb(db, "s1")).toEqual(FULL);
  });

  it("returns {} for an unknown session", () => {
    const db = getDb(tmpPath());
    expect(loadSessionMetaDb(db, "nope")).toEqual({});
  });

  it("upsert preserves created_at and bumps updated_at", () => {
    const db = getDb(tmpPath());
    upsertSessionMeta(db, "s1", { turnCount: 1 }, "2026-01-01T00:00:00.000Z");
    upsertSessionMeta(db, "s1", { turnCount: 2 }, "2026-02-02T00:00:00.000Z");
    const row = db
      .prepare("SELECT created_at, updated_at FROM sessions WHERE name = 's1'")
      .get() as { created_at: string; updated_at: string };
    expect(row.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.updated_at).toBe("2026-02-02T00:00:00.000Z");
    expect(loadSessionMetaDb(db, "s1").turnCount).toBe(2);
  });

  it("autoTitleGenerated false round-trips distinctly from undefined", () => {
    const db = getDb(tmpPath());
    upsertSessionMeta(db, "t", { autoTitleGenerated: false }, "2026-01-01T00:00:00.000Z");
    expect(loadSessionMetaDb(db, "t").autoTitleGenerated).toBe(false);
    upsertSessionMeta(db, "u", {}, "2026-01-01T00:00:00.000Z");
    expect(loadSessionMetaDb(db, "u").autoTitleGenerated).toBeUndefined();
  });

  it("listSessionMetaDb enumerates the union of message-bearing and meta-only sessions", () => {
    const db = getDb(tmpPath());
    // Message-only session — no sessions-table row (LEFT JOIN → empty meta).
    appendSessionMessageDb(db, "msgonly", { role: "user", content: "hi" });
    appendSessionMessageDb(db, "msgonly", { role: "assistant", content: "yo" });
    // Meta-only session — no messages.
    upsertSessionMeta(db, "metaonly", { branch: "dev" }, "2026-01-01T00:00:00.000Z");
    const byName = new Map(listSessionMetaDb(db).map((r) => [r.name, r]));
    expect(byName.get("msgonly")?.messageCount).toBe(2);
    expect(byName.get("msgonly")?.meta).toEqual({});
    expect(byName.get("metaonly")?.messageCount).toBe(0);
    expect(byName.get("metaonly")?.meta).toEqual({ branch: "dev" });
  });
});

import type { Db } from "./db.js";

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

// Business-table migrations applied in version order. version 1 = usage (Slice 2),
// version 2 = events (Slice 3), version 3 = sessions (Slice 4a), version 4 = memory
// (Slice 4b), version 5 = migration_state (activation: migrate-store idempotency).
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "usage",
    up: (db) => {
      db.exec(
        "CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, reasoning_tokens INTEGER, cache_hit_tokens INTEGER NOT NULL, cache_miss_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, claude_equiv_usd REAL NOT NULL, workspace TEXT, kind TEXT NOT NULL DEFAULT 'turn', subagent_json TEXT)",
      );
      db.exec("CREATE INDEX idx_usage_ts ON usage(ts)");
      db.exec("CREATE INDEX idx_usage_workspace_ts ON usage(workspace, ts)");
      db.exec("CREATE INDEX idx_usage_session ON usage(session)");
    },
  },
  {
    version: 2,
    name: "events",
    up: (db) => {
      db.exec(
        "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, event_id INTEGER NOT NULL, ts TEXT, turn INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session, event_id))",
      );
      // UNIQUE(session, event_id) already indexes the replay path
      // (WHERE session=? ORDER BY event_id); no separate index. No FK to sessions
      // yet (that table lands in Slice 4) and no DELETE trigger — whole-session
      // purge is an explicit DELETE / future CASCADE, never row-level.
      db.exec(
        "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END",
      );
    },
  },
  {
    version: 3,
    name: "sessions",
    up: (db) => {
      db.exec(
        "CREATE TABLE sessions (name TEXT PRIMARY KEY, branch TEXT, summary TEXT, total_cost_usd REAL, turn_count INTEGER, workspace TEXT, balance_currency TEXT, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER, last_prompt_tokens INTEGER, auto_title_generated INTEGER, source TEXT, created_at TEXT, updated_at TEXT, pending TEXT, plan_json TEXT, plan_toon TEXT)",
      );
      db.exec("CREATE INDEX idx_sessions_workspace ON sessions(workspace)");
      db.exec("CREATE INDEX idx_sessions_updated ON sessions(updated_at)");
      // session_messages is a rebuildable projection (FR-016), replayed ORDER BY
      // seq (autoincrement is already monotonic — no ord column / read-then-write
      // race). The whole ChatMessage is stored as a JSON payload, NOT split into
      // typed columns: ChatMessage's content?: string | null tri-state can't
      // survive a column-NULL round-trip, and JSON.stringify escapes NUL / lone
      // surrogates so TEXT never mangles them — this is what makes SC-001
      // byte-faithful. role is the one promoted column, for cheap filtering.
      db.exec(
        "CREATE TABLE session_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, role TEXT NOT NULL, payload TEXT NOT NULL)",
      );
      db.exec("CREATE INDEX idx_session_messages_session ON session_messages(session, seq)");
      // Two-generation recovery (FR-018): replaceLog snapshots the prior rows here
      // before DELETE+INSERT. SQLite's transaction already makes a mid-replace crash
      // a ROLLBACK no-op; _bak is the explicit one-generation-back archive.
      db.exec(
        "CREATE TABLE session_messages_bak (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, role TEXT NOT NULL, payload TEXT NOT NULL)",
      );
    },
  },
  {
    version: 4,
    name: "memory",
    up: (db) => {
      // PK (scope, project_hash, name): scope is the 2-value enum, project_hash is
      // projectHash() or "" for global. Without project_hash two projects' same-named
      // memory would UPSERT over each other in the shared DB (FR-019).
      db.exec(
        "CREATE TABLE memory (scope TEXT NOT NULL, project_hash TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, priority TEXT, expires TEXT, PRIMARY KEY (scope, project_hash, name))",
      );
    },
  },
  {
    version: 5,
    name: "migration_state",
    up: (db) => {
      // Per-subsystem migration ledger so `migrate-store` is idempotent: a row here
      // means that subsystem's file data was already copied into SQLite, so a re-run
      // skips it (never double-imports). archived_to records where the source files
      // were moved (never deleted — FR rollback safety); NULL when nothing was found
      // to archive. Separate from schema_migrations (DDL) — this tracks DATA import.
      db.exec(
        "CREATE TABLE migration_state (subsystem TEXT PRIMARY KEY, migrated_at TEXT NOT NULL, source_count INTEGER NOT NULL, archived_to TEXT)",
      );
    },
  },
];

export function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set<number>();
  for (const row of db.prepare("SELECT version FROM schema_migrations").all()) {
    applied.add(Number(row.version));
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.tx(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
  }
}

export function appliedVersions(db: Db): number[] {
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number(row.version));
}

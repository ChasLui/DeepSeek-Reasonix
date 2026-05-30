import type { SessionMeta } from "../memory/session.js";
import type { ChatMessage } from "../types.js";
import type { Db } from "./db.js";

export function appendSessionMessageDb(db: Db, session: string, msg: ChatMessage): void {
  db.withBusyRetry(() =>
    db
      .prepare("INSERT INTO session_messages (session, role, payload) VALUES (?, ?, ?)")
      .run(session, msg.role, JSON.stringify(msg)),
  );
}

export function loadSessionMessagesDb(db: Db, session: string): ChatMessage[] {
  // 0 rows means a deliberate empty log (archive-to-empty): SQLite transactions
  // rule out the torn-write corruption the JSONL .bak fallback guards against, so
  // we never silently fall back to the prior generation here.
  const rows = db
    .prepare("SELECT payload FROM session_messages WHERE session = ? ORDER BY seq")
    .all(session) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as ChatMessage);
}

export function priorGeneration(db: Db, session: string): ChatMessage[] {
  const rows = db
    .prepare("SELECT payload FROM session_messages_bak WHERE session = ? ORDER BY seq")
    .all(session) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as ChatMessage);
}

// The single primitive every compactInPlace / rewriteSession call site routes
// through (FR-017): snapshot the live generation into _bak, then atomically
// DELETE + re-INSERT. A throw anywhere inside leaves the live rows untouched.
export function replaceLog(db: Db, session: string, messages: ChatMessage[]): void {
  db.withBusyRetry(() =>
    db.tx(() => {
      db.prepare("DELETE FROM session_messages_bak WHERE session = ?").run(session);
      db.prepare(
        "INSERT INTO session_messages_bak (session, role, payload) SELECT session, role, payload FROM session_messages WHERE session = ? ORDER BY seq",
      ).run(session);
      db.prepare("DELETE FROM session_messages WHERE session = ?").run(session);
      const insert = db.prepare(
        "INSERT INTO session_messages (session, role, payload) VALUES (?, ?, ?)",
      );
      for (const msg of messages) insert.run(session, msg.role, JSON.stringify(msg));
    }),
  );
}

export function deleteSessionDb(db: Db, session: string): void {
  db.withBusyRetry(() =>
    db.tx(() => {
      db.prepare("DELETE FROM session_messages WHERE session = ?").run(session);
      db.prepare("DELETE FROM session_messages_bak WHERE session = ?").run(session);
      db.prepare("DELETE FROM events WHERE session = ?").run(session);
      db.prepare("DELETE FROM sessions WHERE name = ?").run(session);
    }),
  );
}

// SessionMeta ⇄ sessions-table columns. pending / plan_json / plan_toon are NOT
// part of SessionMeta (they shadow separate sidecar files) — upsert never touches
// them, so a future plan-state migrator can own those columns independently.
function metaToRow(meta: SessionMeta): Array<string | number | null> {
  return [
    meta.branch ?? null,
    meta.summary ?? null,
    meta.totalCostUsd ?? null,
    meta.turnCount ?? null,
    meta.workspace ?? null,
    meta.balanceCurrency ?? null,
    meta.cacheHitTokens ?? null,
    meta.cacheMissTokens ?? null,
    meta.lastPromptTokens ?? null,
    meta.autoTitleGenerated === undefined ? null : meta.autoTitleGenerated ? 1 : 0,
    meta.source ?? null,
  ];
}

function rowToMeta(row: Record<string, unknown>): SessionMeta {
  const meta: SessionMeta = {};
  if (row.branch != null) meta.branch = String(row.branch);
  if (row.summary != null) meta.summary = String(row.summary);
  if (row.total_cost_usd != null) meta.totalCostUsd = Number(row.total_cost_usd);
  if (row.turn_count != null) meta.turnCount = Number(row.turn_count);
  if (row.workspace != null) meta.workspace = String(row.workspace);
  if (row.balance_currency != null) meta.balanceCurrency = String(row.balance_currency);
  if (row.cache_hit_tokens != null) meta.cacheHitTokens = Number(row.cache_hit_tokens);
  if (row.cache_miss_tokens != null) meta.cacheMissTokens = Number(row.cache_miss_tokens);
  if (row.last_prompt_tokens != null) meta.lastPromptTokens = Number(row.last_prompt_tokens);
  if (row.auto_title_generated != null)
    meta.autoTitleGenerated = Number(row.auto_title_generated) === 1;
  if (row.source != null) meta.source = String(row.source) as SessionMeta["source"];
  return meta;
}

// Mirror of patchSessionMeta's file write: the caller passes the FULL merged meta,
// so every column is set from it. created_at is preserved across UPSERT (absent from
// the SET list); updated_at bumps each write. now is injected so the migrator can
// backdate to the source file's mtime instead of "now".
export function upsertSessionMeta(db: Db, name: string, meta: SessionMeta, now: string): void {
  db.withBusyRetry(() =>
    db
      .prepare(
        "INSERT INTO sessions (name, branch, summary, total_cost_usd, turn_count, workspace, balance_currency, cache_hit_tokens, cache_miss_tokens, last_prompt_tokens, auto_title_generated, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET branch = excluded.branch, summary = excluded.summary, total_cost_usd = excluded.total_cost_usd, turn_count = excluded.turn_count, workspace = excluded.workspace, balance_currency = excluded.balance_currency, cache_hit_tokens = excluded.cache_hit_tokens, cache_miss_tokens = excluded.cache_miss_tokens, last_prompt_tokens = excluded.last_prompt_tokens, auto_title_generated = excluded.auto_title_generated, source = excluded.source, updated_at = excluded.updated_at",
      )
      .run(name, ...metaToRow(meta), now, now),
  );
}

export function loadSessionMetaDb(db: Db, name: string): SessionMeta {
  const row = db.prepare("SELECT * FROM sessions WHERE name = ?").get(name);
  return row ? rowToMeta(row as Record<string, unknown>) : {};
}

export interface SessionMetaRow {
  name: string;
  meta: SessionMeta;
  messageCount: number;
  updatedAt: string | null;
}

// Powers the SQLite-backend listSessions. The file backend enumerates by .jsonl
// presence, with .meta.json as an optional sidecar — so the canonical universe is
// the UNION of sessions that have messages OR a meta row, LEFT JOIN'd onto sessions
// for the columns (NULL → empty meta). names.name is selected explicitly (not s.*)
// so a meta-less session keeps its real name instead of a NULL s.name collision.
// session.ts maps each row to SessionInfo, synthesizing the canonical jsonl path for
// display-identity since there is no file under SQLite.
export function listSessionMetaDb(db: Db): SessionMetaRow[] {
  const rows = db
    .prepare(
      "SELECT names.name AS name, s.branch AS branch, s.summary AS summary, s.total_cost_usd AS total_cost_usd, s.turn_count AS turn_count, s.workspace AS workspace, s.balance_currency AS balance_currency, s.cache_hit_tokens AS cache_hit_tokens, s.cache_miss_tokens AS cache_miss_tokens, s.last_prompt_tokens AS last_prompt_tokens, s.auto_title_generated AS auto_title_generated, s.source AS source, s.updated_at AS updated_at, (SELECT COUNT(*) FROM session_messages m WHERE m.session = names.name) AS message_count FROM (SELECT DISTINCT session AS name FROM session_messages UNION SELECT name FROM sessions) names LEFT JOIN sessions s ON s.name = names.name",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    name: String(row.name),
    meta: rowToMeta(row),
    messageCount: Number(row.message_count),
    updatedAt: row.updated_at != null ? String(row.updated_at) : null,
  }));
}

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

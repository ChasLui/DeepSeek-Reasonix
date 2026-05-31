/** session_unlocked_tools repo (FR-006): ordered record of deferred tools a
 *  session unlocked, so resume can replay addTool in order (SC-006). Fails soft. */

import type { Db } from "./db.js";

export interface UnlockedToolRow {
  seq: number;
  source: string;
  name: string;
}

/** Next monotonic seq for a session — MAX(seq)+1, or 0 for a fresh session. */
export function nextUnlockSeq(db: Db, session: string): number {
  try {
    const row = db
      .prepare("SELECT MAX(seq) AS m FROM session_unlocked_tools WHERE session = ?")
      .get(session) as { m: number | null } | undefined;
    const max = row?.m;
    return typeof max === "number" ? max + 1 : 0;
  } catch {
    return 0;
  }
}

/** Idempotent ordered insert (PK session+name). Best-effort — in-memory unlock already happened. */
export function recordUnlock(
  db: Db,
  session: string,
  source: string,
  name: string,
  seq: number,
  at: string,
): void {
  try {
    db.withBusyRetry(() =>
      db
        .prepare(
          "INSERT OR IGNORE INTO session_unlocked_tools (session, seq, source, name, unlocked_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(session, seq, source, name, at),
    );
  } catch {
    /* fail soft — unlock persistence is an audit/replay convenience, not load-bearing */
  }
}

/** Unlocked tools for a session in unlock order (seq). Backs resume replay (Task 4.1) + /tools audit. */
export function listUnlockedTools(db: Db, session: string): UnlockedToolRow[] {
  try {
    return db
      .prepare(
        "SELECT seq, source, name FROM session_unlocked_tools WHERE session = ? ORDER BY seq",
      )
      .all(session)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          seq: Number(row.seq),
          source: String(row.source),
          name: String(row.name),
        };
      });
  } catch {
    return [];
  }
}

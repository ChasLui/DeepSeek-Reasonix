import type { Event } from "../core/events.js";
import type { EventSink, EventSource } from "../ports/event-sink.js";
import type { Db } from "../storage/db.js";

const NEXT_ID_SQL = "SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM events WHERE session = ?";
const INSERT_SQL =
  "INSERT INTO events (session, event_id, ts, turn, type, payload) VALUES (?, ?, ?, ?, ?, ?)";

export class SqliteEventSink implements EventSink {
  constructor(
    private readonly db: Db,
    private readonly session: string,
  ) {}

  append(ev: Event): void {
    // Skip model.delta — recoverable from model.final.text, parity with JSONL sink.
    if (ev.type === "model.delta") return;
    try {
      this.db.withBusyRetry(() =>
        this.db.tx(() => {
          // event_id is derived in-transaction from the DB, never the kernel's
          // per-instance counter — concurrent writers to one session stay monotonic
          // and the UNIQUE(session, event_id) constraint cannot collide.
          const row = this.db.prepare(NEXT_ID_SQL).get(this.session) as {
            next: number;
          };
          this.db
            .prepare(INSERT_SQL)
            .run(this.session, Number(row.next), ev.ts, ev.turn, ev.type, JSON.stringify(ev));
        }),
      );
    } catch {
      /* best-effort telemetry — must never break the turn */
    }
  }

  async flush(): Promise<void> {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  async close(): Promise<void> {
    /* the shared connection is owned and closed by getDb's exit hook */
  }
}

export class SqliteEventSource implements EventSource {
  constructor(private readonly db: Db) {}

  // DatabaseSync has no async cursor, so a session's events materialize in full.
  // Fine for replay/inspection; chunk with LIMIT/OFFSET if a session ever outgrows
  // memory.
  async *read(sessionName: string): AsyncIterable<Event> {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE session = ? ORDER BY event_id")
      .all(sessionName) as Array<{ payload: string }>;
    for (const row of rows) {
      yield JSON.parse(row.payload) as Event;
    }
  }
}

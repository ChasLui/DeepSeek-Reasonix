import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventSink, SqliteEventSource } from "../src/adapters/event-sink-sqlite.js";
import type { Event } from "../src/core/events.js";
import { getDb, resetDb } from "../src/storage/db.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-events-")), "reasonix.db");
}

function ev(type: string, turn: number, extra: Record<string, unknown> = {}): Event {
  return { id: turn, ts: `t${turn}`, turn, type, ...extra } as unknown as Event;
}

async function drain(source: SqliteEventSource, session: string): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of source.read(session)) out.push(e);
  return out;
}

afterEach(() => resetDb());

describe("storage/event-sink-sqlite", () => {
  it("round-trips events in append order, skipping model.delta (FR-012)", async () => {
    const db = getDb(tmpPath());
    const sink = new SqliteEventSink(db, "s1");
    sink.append(ev("user.message", 0, { text: "hi" }));
    sink.append(ev("model.delta", 0, { chunk: "x" }));
    sink.append(ev("model.final", 0, { text: "hello" }));
    sink.append(ev("tool.preparing", 1));

    const out = await drain(new SqliteEventSource(db), "s1");
    expect(out.map((e) => e.type)).toEqual(["user.message", "model.final", "tool.preparing"]);
    expect(out[0]).toEqual(ev("user.message", 0, { text: "hi" }));
  });

  it("derives a monotonic event_id per session in-transaction (FR-011)", () => {
    const db = getDb(tmpPath());
    new SqliteEventSink(db, "s1").append(ev("user.message", 0));
    new SqliteEventSink(db, "s1").append(ev("model.final", 0));
    const ids = db
      .prepare("SELECT event_id FROM events WHERE session = 's1' ORDER BY event_id")
      .all()
      .map((r) => Number(r.event_id));
    expect(ids).toEqual([1, 2]);
  });

  it("isolates event_id sequences per session", () => {
    const db = getDb(tmpPath());
    new SqliteEventSink(db, "s1").append(ev("user.message", 0));
    new SqliteEventSink(db, "s2").append(ev("user.message", 0));
    new SqliteEventSink(db, "s1").append(ev("model.final", 0));
    const ids = (session: string) =>
      db
        .prepare("SELECT event_id FROM events WHERE session = ? ORDER BY event_id")
        .all(session)
        .map((r) => Number(r.event_id));
    expect(ids("s1")).toEqual([1, 2]);
    expect(ids("s2")).toEqual([1]);
  });

  it("rejects row-level UPDATE (FR-012 append-only)", () => {
    const db = getDb(tmpPath());
    new SqliteEventSink(db, "s1").append(ev("user.message", 0));
    expect(() => db.exec("UPDATE events SET type = 'x' WHERE session = 's1'")).toThrow(
      /append-only/,
    );
  });
});

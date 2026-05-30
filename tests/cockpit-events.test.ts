import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEventSink } from "../src/adapters/event-sink-sqlite.js";
import type { Event } from "../src/core/events.js";
import { computeEventsCockpit } from "../src/server/api/cockpit-events.js";
import { getDb, resetDb } from "../src/storage/db.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rx-cockpit-events-")), "reasonix.db");
}

interface MakeEventsArgs {
  toolIntents?: Array<{
    ts: number;
    callId: string;
    name: string;
    args?: string;
  }>;
  toolResults?: Array<{ ts: number; callId: string; ok: boolean }>;
  toolDenies?: Array<{ ts: number; callId: string }>;
  planSubmissions?: Array<{
    ts: number;
    id: number;
    body: string;
    steps: Array<{ id: string; title: string }>;
  }>;
  stepCompletions?: Array<{ ts: number; stepId: string }>;
}

function makeEvents(args: MakeEventsArgs): Event[] {
  const events: Event[] = [];
  let id = 1;
  for (const i of args.toolIntents ?? []) {
    events.push({
      id: id++,
      ts: isoAt(i.ts),
      turn: 1,
      type: "tool.intent",
      callId: i.callId,
      name: i.name,
      args: i.args ?? "{}",
    } as unknown as Event);
  }
  for (const r of args.toolResults ?? []) {
    events.push({
      id: id++,
      ts: isoAt(r.ts),
      turn: 1,
      type: "tool.result",
      callId: r.callId,
      ok: r.ok,
      output: "",
      durationMs: 100,
    } as unknown as Event);
  }
  for (const d of args.toolDenies ?? []) {
    events.push({
      id: id++,
      ts: isoAt(d.ts),
      turn: 1,
      type: "tool.denied",
      callId: d.callId,
      reason: "permission",
    } as unknown as Event);
  }
  for (const p of args.planSubmissions ?? []) {
    events.push({
      id: p.id,
      ts: isoAt(p.ts),
      turn: 1,
      type: "plan.submitted",
      body: p.body,
      steps: p.steps.map((s) => ({ id: s.id, title: s.title, action: "" })),
    } as unknown as Event);
  }
  for (const c of args.stepCompletions ?? []) {
    events.push({
      id: id++,
      ts: isoAt(c.ts),
      turn: 1,
      type: "plan.step.completed",
      stepId: c.stepId,
      completion: { kind: "ok" },
    } as unknown as Event);
  }
  return events;
}

describe("computeEventsCockpit", () => {
  beforeEach(() => {
    getDb(tmpDbPath());
  });

  afterEach(() => {
    resetDb();
  });

  function writeSession(name: string, args: MakeEventsArgs): void {
    const sink = new SqliteEventSink(getDb(), name);
    for (const ev of makeEvents(args)) sink.append(ev);
  }

  it("returns null fields when no events are present", () => {
    const out = computeEventsCockpit(NOW);
    expect(out.toolCalls24h).toBeNull();
    expect(out.recentPlans).toBeNull();
    expect(out.toolActivity).toBeNull();
  });

  it("counts tool.intent events in the trailing 24h", () => {
    writeSession("s1", {
      toolIntents: [
        { ts: NOW - 1_000, callId: "c1", name: "run_command" },
        { ts: NOW - 12 * 60 * 60 * 1000, callId: "c2", name: "edit_file" },
        { ts: NOW - 26 * 60 * 60 * 1000, callId: "c3", name: "read_file" },
      ],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.toolCalls24h?.total).toBe(2);
  });

  it("computes delta vs the prior 24h window", () => {
    writeSession("s1", {
      toolIntents: [
        { ts: NOW - 1_000, callId: "c1", name: "x" },
        { ts: NOW - 12 * 3_600_000, callId: "c2", name: "x" },
        { ts: NOW - 30 * 3_600_000, callId: "c3", name: "x" },
      ],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.toolCalls24h?.total).toBe(2);
    expect(out.toolCalls24h?.delta).toBe(1);
  });

  it("surfaces recent tool activity newest-first with ok / err / warn levels", () => {
    writeSession("s1", {
      toolIntents: [
        {
          ts: NOW - 5_000,
          callId: "c1",
          name: "run_command",
          args: '{"command":"npm run build"}',
        },
        {
          ts: NOW - 4_000,
          callId: "c2",
          name: "edit_file",
          args: '{"path":"src/index.ts"}',
        },
        {
          ts: NOW - 3_000,
          callId: "c3",
          name: "shell",
          args: '{"command":"rm -rf"}',
        },
      ],
      toolResults: [
        { ts: NOW - 4_900, callId: "c1", ok: true },
        { ts: NOW - 3_900, callId: "c2", ok: false },
      ],
      toolDenies: [{ ts: NOW - 2_900, callId: "c3" }],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.toolActivity).toHaveLength(3);
    expect(out.toolActivity![0]!.name).toBe("shell");
    expect(out.toolActivity![0]!.level).toBe("warn");
    expect(out.toolActivity![1]!.level).toBe("err");
    expect(out.toolActivity![2]!.level).toBe("ok");
  });

  it("rolls up plans with completion ratio + done/active status", () => {
    writeSession("s1", {
      planSubmissions: [
        {
          ts: NOW - 60_000,
          id: 100,
          body: "release 0.18.1",
          steps: [
            { id: "a", title: "tag" },
            { id: "b", title: "publish" },
          ],
        },
      ],
      stepCompletions: [
        { ts: NOW - 50_000, stepId: "a" },
        { ts: NOW - 40_000, stepId: "b" },
      ],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.recentPlans).toHaveLength(1);
    expect(out.recentPlans![0]!.title).toBe("release 0.18.1");
    expect(out.recentPlans![0]!.totalSteps).toBe(2);
    expect(out.recentPlans![0]!.completedSteps).toBe(2);
    expect(out.recentPlans![0]!.status).toBe("done");
  });

  it("marks a partially-completed plan as active", () => {
    writeSession("s1", {
      planSubmissions: [
        {
          ts: NOW - 60_000,
          id: 100,
          body: "wip",
          steps: [
            { id: "a", title: "x" },
            { id: "b", title: "y" },
            { id: "c", title: "z" },
          ],
        },
      ],
      stepCompletions: [{ ts: NOW - 50_000, stepId: "a" }],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.recentPlans![0]!.status).toBe("active");
    expect(out.recentPlans![0]!.completedSteps).toBe(1);
  });

  it("aggregates tool calls across multiple sessions", () => {
    writeSession("s1", {
      toolIntents: [{ ts: NOW - 1_000, callId: "a", name: "x" }],
    });
    writeSession("s2", {
      toolIntents: [{ ts: NOW - 2_000, callId: "b", name: "y" }],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.toolCalls24h?.total).toBe(2);
  });

  it("skips sessions whose newest event is older than 30 days", () => {
    writeSession("stale", {
      toolIntents: [{ ts: NOW - 31 * DAY, callId: "x", name: "should-not-count" }],
    });
    writeSession("fresh", {
      toolIntents: [{ ts: NOW - 500, callId: "y", name: "should-count" }],
    });
    const out = computeEventsCockpit(NOW);
    expect(out.toolCalls24h?.total).toBe(1);
  });
});

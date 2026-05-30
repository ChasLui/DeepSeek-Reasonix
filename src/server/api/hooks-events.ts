import { listSessionsWithEvents, readSessionEventsDb } from "../../adapters/event-sink-sqlite.js";
import { getDb } from "../../storage/db.js";

export interface HookRunRow {
  hookName: string;
  phase: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  outcome: "ok" | "blocked" | "modified" | "error";
  whenMs: number;
}

const DAY_MS = 86_400_000;
const STALE_DAYS = 30;
const HOOK_LOG_CAP = 12;

export function readRecentHookRuns(
  now: number = Date.now(),
  _sessionsDirOverride?: string,
): ReadonlyArray<HookRunRow> | null {
  const db = getDb();
  const sessions = listSessionsWithEvents(db);
  if (sessions.length === 0) return null;

  const cutoff = now - STALE_DAYS * DAY_MS;
  const rows: HookRunRow[] = [];
  for (const session of sessions) {
    for (const ev of readSessionEventsDb(db, session)) {
      if (ev.type !== "hook.fired") continue;
      const ts = Date.parse(ev.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      rows.push({
        hookName: ev.hookName,
        phase: ev.phase,
        outcome: ev.outcome,
        whenMs: ts,
      });
    }
  }
  rows.sort((a, b) => b.whenMs - a.whenMs);
  return rows.slice(0, HOOK_LOG_CAP);
}

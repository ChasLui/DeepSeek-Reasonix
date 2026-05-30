import type { UsageRecord } from "../telemetry/usage.js";
import type { Db } from "./db.js";

const INSERT_SQL =
  "INSERT INTO usage (ts, session, model, prompt_tokens, completion_tokens, reasoning_tokens, cache_hit_tokens, cache_miss_tokens, cost_usd, claude_equiv_usd, workspace, kind, subagent_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function appendUsageRow(db: Db, record: UsageRecord): void {
  try {
    db.withBusyRetry(() =>
      db
        .prepare(INSERT_SQL)
        .run(
          record.ts,
          record.session,
          record.model,
          record.promptTokens,
          record.completionTokens,
          record.reasoningTokens ?? null,
          record.cacheHitTokens,
          record.cacheMissTokens,
          record.costUsd,
          record.claudeEquivUsd,
          record.workspace ?? null,
          record.kind ?? "turn",
          record.subagent ? JSON.stringify(record.subagent) : null,
        ),
    );
  } catch {
    /* best-effort — usage logging must never break the turn */
  }
}

// Maps a row back to the exact UsageRecord shape so the in-memory aggregateUsage
// stays the single source of bucket/savings/subagent logic (no SQL duplication).
function rowToRecord(row: Record<string, unknown>): UsageRecord {
  const record: UsageRecord = {
    ts: Number(row.ts),
    session: row.session === null || row.session === undefined ? null : String(row.session),
    model: String(row.model),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    cacheHitTokens: Number(row.cache_hit_tokens),
    cacheMissTokens: Number(row.cache_miss_tokens),
    costUsd: Number(row.cost_usd),
    claudeEquivUsd: Number(row.claude_equiv_usd),
  };
  if (row.reasoning_tokens !== null && row.reasoning_tokens !== undefined) {
    record.reasoningTokens = Number(row.reasoning_tokens);
  }
  if (row.workspace !== null && row.workspace !== undefined) {
    record.workspace = String(row.workspace);
  }
  if (row.kind === "subagent") record.kind = "subagent";
  if (row.subagent_json !== null && row.subagent_json !== undefined) {
    record.subagent = JSON.parse(String(row.subagent_json)) as UsageRecord["subagent"];
  }
  return record;
}

export function readAllUsage(db: Db): UsageRecord[] {
  return db.prepare("SELECT * FROM usage ORDER BY ts, id").all().map(rowToRecord);
}

export function readUsageSince(db: Db, since: number): UsageRecord[] {
  return db
    .prepare("SELECT * FROM usage WHERE ts >= ? ORDER BY ts, id")
    .all(since)
    .map(rowToRecord);
}

export function countByModel(db: Db): Array<{ model: string; turns: number }> {
  return db
    .prepare("SELECT model, count(*) AS turns FROM usage GROUP BY model ORDER BY turns DESC, model")
    .all()
    .map((row) => ({ model: String(row.model), turns: Number(row.turns) }));
}

export function countBySession(db: Db): Array<{ session: string; turns: number }> {
  return db
    .prepare(
      "SELECT COALESCE(session, '(ephemeral)') AS session, count(*) AS turns FROM usage GROUP BY COALESCE(session, '(ephemeral)') ORDER BY turns DESC, session",
    )
    .all()
    .map((row) => ({ session: String(row.session), turns: Number(row.turns) }));
}

// Retention is a doctor/maintenance operation, never piggybacked on append
// (range-DELETE holding the write lock on the hot turn path would be a silent
// cost escalation — see plan FR-009 / NF-008).
export function pruneUsageBefore(db: Db, cutoff: number): number {
  return Number(db.prepare("DELETE FROM usage WHERE ts < ?").run(cutoff).changes);
}

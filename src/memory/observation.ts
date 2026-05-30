import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SqliteMemoryStore } from "../adapters/memory-store-sqlite.js";
import type { ReasonixConfig } from "../config.js";
import type { HookPayload } from "../hooks.js";
import { countTokens } from "../tokenizer.js";
import { memoryRootFromHome } from "./access.js";
import { BUILTIN_MEMORY_TYPES, type MemoryScope, sanitizeMemoryName } from "./user.js";

export interface ObservationBudgets {
  maxLines?: number;
  maxWrites?: number;
  aggregateBytes?: number;
  aggregateTokens?: number;
  lineMaxBytes?: number;
}

export interface ObservationOptions {
  store: SqliteMemoryStore;
  autoCapture?: boolean;
  budgets?: ObservationBudgets;
  config?: ReasonixConfig;
}

export interface ObservationResult {
  written: number;
  skipped: number;
  reasons: string[];
}

interface ObservationCandidate {
  v?: unknown;
  type?: unknown;
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

const DEFAULT_BUDGETS = {
  maxLines: 50,
  maxWrites: 20,
  aggregateBytes: 65_536,
  aggregateTokens: 4096,
  lineMaxBytes: 16_384,
} satisfies Required<ObservationBudgets>;
const OBSERVATION_FILE = ".observations.jsonl";

export async function extractObservationFromHook(
  payload: HookPayload,
  raw: { stdout: string; stderr: string },
  opts: ObservationOptions,
): Promise<ObservationResult> {
  if (!opts.autoCapture || process.env.REASONIX_MEMORY_AUTO === "0") {
    return { written: 0, skipped: 0, reasons: [] };
  }
  if (payload.event !== "Stop") return { written: 0, skipped: 1, reasons: ["non_stop_event"] };

  const budgets = { ...DEFAULT_BUDGETS, ...(opts.budgets ?? {}) };
  const allowedTypes = new Set([
    ...BUILTIN_MEMORY_TYPES,
    ...(opts.config?.memory?.customTypes ?? []).map((entry) => entry.name),
  ]);
  const scope: MemoryScope = opts.store.hasProjectScope() ? "project" : "global";
  const result: ObservationResult = { written: 0, skipped: 0, reasons: [] };
  let aggregateBytes = 0;
  let aggregateTokens = 0;
  const lines = raw.stdout.split(/\r?\n/).slice(0, budgets.maxLines);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lineBytes = Buffer.byteLength(trimmed, "utf8");
    if (lineBytes > budgets.lineMaxBytes) {
      skip(result, "line_too_large");
      continue;
    }
    if (result.written >= budgets.maxWrites) {
      skip(result, "max_writes");
      break;
    }
    if (aggregateBytes + lineBytes > budgets.aggregateBytes) {
      skip(result, "aggregate_bytes");
      break;
    }
    const candidate = parseCandidate(trimmed);
    if (!candidate) {
      skip(result, "invalid_json");
      continue;
    }
    if (candidate.v !== 1) {
      skip(result, "unsupported_version");
      continue;
    }
    if (typeof candidate.type !== "string" || !allowedTypes.has(candidate.type)) {
      skip(result, "invalid_type");
      continue;
    }
    let name: string;
    try {
      if (typeof candidate.name !== "string") throw new Error("invalid name");
      name = sanitizeMemoryName(candidate.name);
    } catch {
      skip(result, "invalid_name");
      continue;
    }
    if (typeof candidate.description !== "string" || typeof candidate.body !== "string") {
      skip(result, "invalid_shape");
      continue;
    }
    if (candidate.description.length > 200) {
      skip(result, "description_too_long");
      continue;
    }
    if (Buffer.byteLength(candidate.body, "utf8") > 8192) {
      skip(result, "body_too_large");
      continue;
    }
    const tokens = countTokens(`${candidate.description}\n${candidate.body}`);
    if (aggregateTokens + tokens > budgets.aggregateTokens) {
      skip(result, "aggregate_tokens");
      break;
    }
    opts.store.write({
      scope,
      name,
      type: candidate.type,
      description: candidate.description,
      body: candidate.body,
    });
    appendObservationEvent(opts.store, scope, name);
    result.written += 1;
    aggregateBytes += lineBytes;
    aggregateTokens += tokens;
  }

  return result;
}

export function countRecentObservationEvents(
  homeDir: string = join(homedir(), ".reasonix"),
  now: number = Date.now(),
): number {
  const file = join(memoryRootFromHome(homeDir), OBSERVATION_FILE);
  if (!existsSync(file)) return 0;
  const cutoff = now - 24 * 60 * 60 * 1000;
  let count = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      if (typeof parsed.ts === "string" && Date.parse(parsed.ts) >= cutoff) count += 1;
    } catch {
      /* skip malformed sidecar lines */
    }
  }
  return count;
}

function parseCandidate(line: string): ObservationCandidate | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ObservationCandidate;
  } catch {
    return null;
  }
}

function skip(result: ObservationResult, reason: string): void {
  result.skipped += 1;
  result.reasons.push(reason);
}

function appendObservationEvent(store: SqliteMemoryStore, scope: MemoryScope, name: string): void {
  // Sidecar lives under the memory root — no per-scope dir() needed under SQLite.
  const root = store.memoryRoot();
  mkdirSync(root, { recursive: true });
  appendFileSync(
    join(root, OBSERVATION_FILE),
    `${JSON.stringify({ ts: new Date().toISOString(), scope, name })}\n`,
    { encoding: "utf8", flag: "a" },
  );
}

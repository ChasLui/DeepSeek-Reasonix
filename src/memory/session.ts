/** Append-only conversation log backed by SQLite (`~/.reasonix/reasonix.db`). */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix as posixPath, win32 as win32Path } from "node:path";
import { getDb } from "../storage/db.js";
import {
  appendSessionMessageDb,
  archiveSessionDb,
  deleteSessionDb,
  listSessionMetaDb,
  loadSessionMessagesDb,
  loadSessionMetaDb,
  renameSessionDb,
  replaceLog,
  upsertSessionMeta,
} from "../storage/sessions-repo.js";
import type { ChatMessage } from "../types.js";

/** Best-effort git branch sniff; returns undefined if not a git repo or git missing. */
export function detectGitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 800,
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export interface SessionInfo {
  name: string;
  path: string;
  size: number;
  messageCount: number;
  mtime: Date;
  meta: SessionMeta;
}

export interface SessionMeta {
  branch?: string;
  summary?: string;
  totalCostUsd?: number;
  turnCount?: number;
  /** Absolute path of the workspace root the session was created/used in. */
  workspace?: string;
  /** Wallet currency at last save — used to format `totalCostUsd` in the picker without re-fetching balance. */
  balanceCurrency?: string;
  /** Cumulative cache hit / miss tokens across the session — survives resume so /status cache% isn't 0 on a fresh boot. */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  /** Last turn's promptTokens — lets /status render the context bar before the next turn fires. */
  lastPromptTokens?: number;
  /** True when the session filename/summary was generated from conversation content. */
  autoTitleGenerated?: boolean;
  /** Import provenance for sessions copied from other tools. */
  source?: "claude-code" | (string & {});
}

export interface ImportClaudeCodeSessionResult {
  sessionId: string;
  path: string;
  added: number;
  skipped: number;
  duplicate: boolean;
  reasons: Record<string, number>;
}

export function sessionsDir(): string {
  return join(homedir(), ".reasonix", "sessions");
}

export function sessionPath(name: string): string {
  return join(sessionsDir(), `${sanitizeName(name)}.jsonl`);
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^\w\-\u4e00-\u9fa5]/g, "_").slice(0, 64);
  return cleaned || "default";
}

/** Sortable timestamp `YYYYMMDDHHmm` — used as a session-name suffix. */
export function timestampSuffix(): string {
  return new Date().toISOString().replace(/[^\d]/g, "").slice(0, 12);
}

/** Unique name for an in-app "new session" — strips a trailing 12/14-digit timestamp from the current name and re-stamps with seconds precision so back-to-back clicks don't collide. */
export function freshSessionName(currentName: string | undefined): string {
  const base = currentName ? currentName.replace(/-\d{12,14}$/, "") : "default";
  const stamp = new Date().toISOString().replace(/[^\d]/g, "").slice(0, 14);
  return `${base || "default"}-${stamp}`;
}

/** Names of message-bearing sessions starting with `prefix`, newest-first (name
 * sort+reverse → zero-padded timestamps newest-first). Meta-only sessions (no
 * conversation-log rows) are excluded, mirroring the old `.jsonl`-file semantics. */
export function findSessionsByPrefix(prefix: string): string[] {
  return listSessionMetaDb(getDb())
    .filter((row) => row.messageCount > 0 && row.name.startsWith(prefix))
    .map((row) => row.name)
    .sort()
    .reverse();
}

export interface SessionPreview {
  messageCount: number;
  lastActive: Date;
}

/** Resolve launch-time session: forceNew → timestamped suffix; else latest `${name}-*` if any, else base. Preview returned only on the default branch when messages exist. */
export function resolveSession(
  sessionName: string | undefined,
  forceNew?: boolean,
  forceResume?: boolean,
): { resolved: string | undefined; preview: SessionPreview | undefined } {
  let resolved = sessionName;
  let preview: SessionPreview | undefined;

  if (sessionName && forceNew) {
    resolved = `${sessionName}-${timestampSuffix()}`;
  } else if (sessionName && !forceResume) {
    let sessionToCheck = sessionName;
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      sessionToCheck = prefixed[0]!;
    }
    const prior = loadSessionMessages(sessionToCheck);
    if (prior.length > 0) {
      resolved = sessionToCheck;
      const meta = listSessionMetaDb(getDb()).find((r) => r.name === sanitizeName(sessionToCheck));
      const lastActive = meta?.updatedAt ? new Date(meta.updatedAt) : new Date();
      preview = { messageCount: prior.length, lastActive };
    }
  } else if (sessionName && forceResume) {
    const prefixed = findSessionsByPrefix(`${sessionName}-`);
    if (prefixed.length > 0) {
      resolved = prefixed[0]!;
    }
  }

  return { resolved, preview };
}

export function loadSessionMessages(name: string): ChatMessage[] {
  return loadSessionMessagesDb(getDb(), sanitizeName(name));
}

export function importClaudeCodeSession(file: string): ImportClaudeCodeSessionResult {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`not a file: ${file}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error(`session jsonl too large: ${file}`);

  const raw = readFileSync(file, "utf8");
  const messages: ChatMessage[] = [];
  const reasons: Record<string, number> = Object.create(null) as Record<string, number>;
  let sessionId: string | undefined;
  let skipped = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      bump(reasons, "invalid_json");
      continue;
    }
    sessionId ??= extractSessionId(parsed);
    const normalized = normalizeClaudeMessage(parsed);
    if (!normalized.message) {
      skipped += 1;
      bump(reasons, normalized.reason);
      continue;
    }
    messages.push(normalized.message);
  }

  const safeSessionId = sanitizeName(sessionId ?? fallbackImportedSessionId(file));
  // Display-identity path only — there is no reasonix jsonl under SQLite.
  const path = sessionPath(safeSessionId);
  // Dedup against SQLite: the destination session already has messages.
  if (loadSessionMessagesDb(getDb(), safeSessionId).length > 0) {
    return {
      sessionId: safeSessionId,
      path,
      added: 0,
      skipped: skipped + messages.length,
      duplicate: true,
      reasons,
    };
  }
  if (messages.length === 0) {
    return {
      sessionId: safeSessionId,
      path,
      added: 0,
      skipped,
      duplicate: false,
      reasons,
    };
  }

  rewriteSession(safeSessionId, messages);
  patchSessionMeta(safeSessionId, { source: "claude-code" });
  return {
    sessionId: safeSessionId,
    path,
    added: messages.length,
    skipped,
    duplicate: false,
    reasons,
  };
}

export function appendSessionMessage(name: string, message: ChatMessage): void {
  appendSessionMessageDb(getDb(), sanitizeName(name), message);
}

export function listSessions(opts?: {
  workspaceFilter?: string;
  sourceFilter?: string;
}): SessionInfo[] {
  const want = opts?.workspaceFilter ? normalizeWorkspace(opts.workspaceFilter) : null;
  return listSessionMetaDb(getDb())
    .filter((row) => {
      if (opts?.sourceFilter && row.meta.source !== opts.sourceFilter) return false;
      if (want !== null) {
        if (typeof row.meta.workspace !== "string") return false;
        if (normalizeWorkspace(row.meta.workspace) !== want) return false;
      }
      return true;
    })
    .map((row) => ({
      name: row.name,
      // No file under SQLite — synthesize the canonical jsonl path so callers
      // that key on `.path` for identity/display keep working.
      path: sessionPath(row.name),
      size: 0,
      messageCount: row.messageCount,
      mtime: row.updatedAt ? new Date(row.updatedAt) : new Date(0),
      meta: row.meta,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Canonical form for workspace path comparisons — Windows drive-case + separator drift between session writes (yesterday) and reads (today) used to hide sessions from the sidebar. Issue #878. */
export function normalizeWorkspace(
  p: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof p !== "string" || p.length === 0) return "";
  if (platform === "win32") {
    const resolved = win32Path.resolve(p);
    return resolved
      .replace(/\\/g, "/")
      .replace(/^([A-Z]):/i, (_, d: string) => `${d.toLowerCase()}:`);
  }
  return posixPath.resolve(p);
}

/** Sessions without `meta.workspace` are still hidden — resume by name still works. */
export function listSessionsForWorkspace(workspace: string): SessionInfo[] {
  return listSessions({ workspaceFilter: workspace });
}

export function loadSessionMeta(name: string): SessionMeta {
  return loadSessionMetaDb(getDb(), sanitizeName(name));
}

export function patchSessionMeta(name: string, patch: Partial<SessionMeta>): SessionMeta {
  const cur = loadSessionMeta(name);
  const next: SessionMeta = { ...cur, ...patch };
  upsertSessionMeta(getDb(), sanitizeName(name), next, new Date().toISOString());
  return next;
}

/** Renames a session's identity across all SQLite tables atomically; returns false on collision. */
export function renameSession(oldName: string, newName: string): boolean {
  return renameSessionDb(getDb(), sanitizeName(oldName), sanitizeName(newName));
}

/** Best-effort: per-file delete errors are swallowed so partial pruning still finishes. */
export function pruneStaleSessions(daysOld = 90): string[] {
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  for (const s of listSessions()) {
    if (s.mtime.getTime() < cutoff) {
      if (deleteSession(s.name)) deleted.push(s.name);
    }
  }
  return deleted;
}

export function deleteSession(name: string): boolean {
  deleteSessionDb(getDb(), sanitizeName(name));
  return true;
}

/** Atomic replace of the live log (snapshots the prior generation into _bak). */
export function rewriteSession(name: string, messages: ChatMessage[]): void {
  replaceLog(getDb(), sanitizeName(name), messages);
}

/** Rename the live log to `<name>__archive_<ts>` so /new doesn't destroy history. Returns the archive name, or null if there was nothing to archive. */
export function archiveSession(name: string): string | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = `${name}__archive_${timestampSuffix()}${attempt > 0 ? `_${attempt}` : ""}`;
    if (archiveSessionDb(getDb(), sanitizeName(name), sanitizeName(target))) {
      return target;
    }
  }
  return null;
}

type NormalizeMessageResult =
  | { message: ChatMessage; reason?: never }
  | { message: null; reason: "invalid_message" | "invalid_tool_call" };

interface NormalizedToolCalls {
  ok: boolean;
  calls: NonNullable<ChatMessage["tool_calls"]>;
}

function normalizeClaudeMessage(raw: unknown): NormalizeMessageResult {
  if (!raw || typeof raw !== "object") return { message: null, reason: "invalid_message" };
  const outer = raw as { message?: unknown };
  const source = outer.message && typeof outer.message === "object" ? outer.message : raw;
  if (!source || typeof source !== "object") return { message: null, reason: "invalid_message" };
  const value = source as {
    role?: unknown;
    type?: unknown;
    content?: unknown;
    name?: unknown;
    tool_call_id?: unknown;
    tool_calls?: unknown;
  };
  const role = normalizeRole(value.role ?? value.type);
  if (!role) return { message: null, reason: "invalid_message" };
  const content = normalizeContent(value.content);
  if (content === undefined) return { message: null, reason: "invalid_message" };
  const toolCalls = normalizeToolCalls(value.tool_calls, value.content);
  if (!toolCalls.ok) return { message: null, reason: "invalid_tool_call" };
  const msg: ChatMessage = { role };
  if (content !== null) msg.content = content;
  if (typeof value.name === "string") msg.name = value.name;
  if (typeof value.tool_call_id === "string") msg.tool_call_id = value.tool_call_id;
  if (toolCalls.calls.length > 0) msg.tool_calls = toolCalls.calls;
  return { message: msg };
}

function normalizeRole(raw: unknown): ChatMessage["role"] | null {
  if (raw === "system" || raw === "user" || raw === "assistant" || raw === "tool") return raw;
  return null;
}

function normalizeContent(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return undefined;
  const parts: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.content === "string") parts.push(block.content);
  }
  return parts.join("\n");
}

function normalizeToolCalls(rawToolCalls: unknown, rawContent: unknown): NormalizedToolCalls {
  const calls: NonNullable<ChatMessage["tool_calls"]> = [];
  if (rawToolCalls !== undefined) {
    if (!Array.isArray(rawToolCalls)) return { ok: false, calls: [] };
    for (const item of rawToolCalls) {
      const call = normalizeToolCall(item);
      if (!call) return { ok: false, calls: [] };
      calls.push(call);
    }
  }
  const contentCalls = toolCallsFromContent(rawContent);
  if (!contentCalls.ok) return { ok: false, calls: [] };
  calls.push(...contentCalls.calls);
  return { ok: true, calls };
}

function normalizeToolCall(item: unknown): NonNullable<ChatMessage["tool_calls"]>[number] | null {
  if (!item || typeof item !== "object") return null;
  const value = item as {
    id?: unknown;
    type?: unknown;
    name?: unknown;
    input?: unknown;
    function?: unknown;
  };
  const fn =
    value.function && typeof value.function === "object"
      ? (value.function as { name?: unknown; arguments?: unknown })
      : value;
  const name = typeof fn.name === "string" && fn.name.trim() ? fn.name : undefined;
  if (!name) return null;
  const args =
    "arguments" in fn
      ? stringifyToolArguments(fn.arguments)
      : "input" in value
        ? stringifyToolArguments(value.input)
        : "";
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    type: "function",
    function: { name, arguments: args },
  };
}

function toolCallsFromContent(raw: unknown): NormalizedToolCalls {
  if (!Array.isArray(raw)) return { ok: true, calls: [] };
  const out: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    if (type !== "tool_use") continue;
    const call = normalizeToolCall(item);
    if (!call) return { ok: false, calls: [] };
    out.push(call);
  }
  return { ok: true, calls: out };
}

function stringifyToolArguments(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined) return "";
  return JSON.stringify(raw);
}

function extractSessionId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as {
    sessionId?: unknown;
    session_id?: unknown;
    conversationId?: unknown;
  };
  for (const candidate of [value.sessionId, value.session_id, value.conversationId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function fallbackImportedSessionId(file: string): string {
  const base = basename(file).replace(/\.jsonl$/i, "");
  const hash = createHash("sha1").update(file).digest("hex").slice(0, 8);
  return `${base || "claude-code"}-${hash}`;
}

function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

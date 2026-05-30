/** One-shot file→SQLite migration (the activation step): copy-only by default,
 * idempotent per subsystem, never destructive. See migrateStore() for the model. */

import {
  type Dirent,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteEventSink } from "../adapters/event-sink-sqlite.js";
import { readEventLogFile } from "../adapters/event-source-jsonl.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { SessionMeta } from "../memory/session.js";
import {
  MEMORY_INDEX_FILE,
  type MemoryEntry,
  type MemoryScope,
  type MemoryType,
} from "../memory/user.js";
import type { UsageRecord } from "../telemetry/usage.js";
import type { ChatMessage } from "../types.js";
import { nullPrototype } from "../utils/safe-object.js";
import type { Db } from "./db.js";
import { getDb } from "./db.js";
import { setStoreBackend } from "./select.js";
import { appendSessionMessageDb, upsertSessionMeta } from "./sessions-repo.js";
import { appendUsageRow } from "./usage-repo.js";

export const SUBSYSTEMS = ["usage", "sessions", "events", "memory"] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export interface MigrateOptions {
  /** `~/.reasonix` root override (tests). */
  homeDir?: string;
  /** Flip `.store-version` to sqlite after a clean copy. Default false (copy only). */
  activate?: boolean;
  /** Count source records without writing. */
  dryRun?: boolean;
  /** Restrict to specific subsystems. Default: all. */
  only?: readonly Subsystem[];
  /** Inject the DB (tests / explicit connection). Defaults to getDb(<home>/reasonix.db). */
  db?: Db;
}

export interface SubsystemResult {
  name: Subsystem;
  /** Records copied (sessions: # of session logs; others: # of rows). */
  count: number;
  /** Already recorded in migration_state — left untouched. */
  skipped: boolean;
}

export interface MigrateResult {
  subsystems: SubsystemResult[];
  /** True iff `.store-version` was flipped to sqlite this run. */
  activated: boolean;
  dryRun: boolean;
}

function reasonixHome(opts: MigrateOptions): string {
  return opts.homeDir ?? join(homedir(), ".reasonix");
}

/** Parse a session jsonl into ChatMessage[], skipping blank / malformed lines. */
function parseJsonlMessages(path: string): ChatMessage[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as ChatMessage;
      if (msg && typeof msg === "object" && "role" in msg) out.push(msg);
    } catch {
      /* skip malformed line — parity with readSessionMessages */
    }
  }
  return out;
}

function readMetaFile(path: string): SessionMeta | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SessionMeta;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** ISO of a file's mtime, so migrated sessions keep their original sort order. */
function fileMtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function migrateUsage(db: Db, home: string, dryRun: boolean): number {
  // `home` is the `.reasonix` dir itself, so the legacy usage log sits directly
  // under it. Parse the jsonl in-place (the runtime usage reader is SQLite-only
  // now and no longer accepts a path) and copy each row into the `usage` table.
  const path = join(home, "usage.jsonl");
  if (!existsSync(path)) return 0;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: UsageRecord;
    try {
      record = JSON.parse(line) as UsageRecord;
    } catch {
      continue;
    }
    if (typeof record.ts !== "number" || typeof record.model !== "string") {
      continue;
    }
    if (!dryRun) appendUsageRow(db, record);
    count++;
  }
  return count;
}

function migrateSessions(db: Db, home: string, dryRun: boolean): number {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return 0;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  const stems = files
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".events.jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
  let count = 0;
  for (const stem of stems) {
    const messages = parseJsonlMessages(join(dir, `${stem}.jsonl`));
    if (!dryRun) {
      for (const msg of messages) appendSessionMessageDb(db, stem, msg);
      const metaPath = join(dir, `${stem}.meta.json`);
      const meta = readMetaFile(metaPath);
      if (meta) {
        upsertSessionMeta(db, stem, meta, fileMtimeIso(metaPath) ?? new Date().toISOString());
      }
    }
    count += 1;
  }
  return count;
}

function migrateEvents(db: Db, home: string, dryRun: boolean): number {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return 0;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const file of files.filter((f) => f.endsWith(".events.jsonl"))) {
    const session = file.replace(/\.events\.jsonl$/, "");
    const events = readEventLogFile(join(dir, file));
    if (!dryRun) {
      // event_id is re-derived in-sink as MAX+1, so appending in file order keeps
      // replay order monotonic; model.delta rows are dropped (recoverable from
      // model.final), exactly as a live SQLite sink would have behaved.
      const sink = new SqliteEventSink(db, session);
      for (const ev of events) sink.append(ev);
    }
    count += events.length;
  }
  return count;
}

const MEMORY_INSERT_SQL =
  "INSERT INTO memory (scope, project_hash, name, type, description, body, created_at, priority, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, project_hash, name) DO UPDATE SET type = excluded.type, description = excluded.description, body = excluded.body, created_at = excluded.created_at, priority = excluded.priority, expires = excluded.expires";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Mirrors user.ts MemoryStore.read's frontmatter mapping. Returns null on an
// unreadable file so one malformed entry doesn't abort the whole subsystem.
function readMemoryFile(
  path: string,
  scope: MemoryScope,
  fallbackName: string,
): MemoryEntry | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const entry: MemoryEntry = {
    name: data.name ?? fallbackName,
    type: (data.type as MemoryType) ?? "project",
    scope: (data.scope as MemoryScope) ?? scope,
    description: data.description ?? "",
    body: body.trim(),
    createdAt: data.created ?? "",
  };
  if (data.priority) entry.priority = data.priority as MemoryEntry["priority"];
  if (data.expires) entry.expires = data.expires as MemoryEntry["expires"];
  return entry;
}

// Enumerates EVERY `<home>/memory/<dir>` — `global` (project_hash="") plus one dir
// per project, named by its project_hash. The dir name IS the hash, so we insert it
// verbatim (no inverting projectRoot→hash) and thus migrate every project's memory,
// not just the cwd one. Skipping foreign projects would make their memory vanish
// from view after the backend flip even though the files remain on disk.
function migrateMemory(db: Db, home: string, dryRun: boolean): number {
  const memRoot = join(home, "memory");
  if (!existsSync(memRoot)) return 0;
  let dirEntries: Dirent[];
  try {
    dirEntries = readdirSync(memRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const insert = dryRun ? null : db.prepare(MEMORY_INSERT_SQL);
  let count = 0;
  for (const dirent of dirEntries) {
    if (!dirent.isDirectory() || dirent.name === ".index") continue;
    const scope: MemoryScope = dirent.name === "global" ? "global" : "project";
    const projectHash = dirent.name === "global" ? "" : dirent.name;
    const dir = join(memRoot, dirent.name);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file === MEMORY_INDEX_FILE || !file.endsWith(".md")) continue;
      const entry = readMemoryFile(join(dir, file), scope, file.slice(0, -3));
      if (!entry) continue;
      count += 1;
      if (insert) {
        db.withBusyRetry(() =>
          insert.run(
            scope,
            projectHash,
            entry.name,
            entry.type,
            entry.description,
            entry.body,
            entry.createdAt || todayIso(),
            entry.priority ?? null,
            entry.expires ?? null,
          ),
        );
      }
    }
  }
  return count;
}

const MIGRATORS: Record<Subsystem, (db: Db, home: string, dryRun: boolean) => number> =
  nullPrototype({
    usage: migrateUsage,
    sessions: migrateSessions,
    events: migrateEvents,
    memory: migrateMemory,
  });

function migratedSet(db: Db): Set<string> {
  const rows = db.prepare("SELECT subsystem FROM migration_state").all() as Array<{
    subsystem: string;
  }>;
  return new Set(rows.map((r) => r.subsystem));
}

function recordMigration(db: Db, subsystem: Subsystem, count: number): void {
  db.prepare(
    "INSERT INTO migration_state (subsystem, migrated_at, source_count, archived_to) VALUES (?, ?, ?, NULL) ON CONFLICT(subsystem) DO UPDATE SET migrated_at = excluded.migrated_at, source_count = excluded.source_count",
  ).run(subsystem, new Date().toISOString(), count);
}

/** Advisory lock via O_EXCL — a concurrent migrate-store cannot interleave writes. */
function acquireLock(home: string): string {
  mkdirSync(home, { recursive: true });
  const lockPath = join(home, ".migrate.lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`another migrate-store is in progress (remove ${lockPath} if stale)`);
    }
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return lockPath;
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

// Copy file-backed data into SQLite. Idempotent (per-subsystem ledger), non-destructive
// (source files untouched); only flips the backend when `activate` is set after a clean copy.
export function migrateStore(opts: MigrateOptions = {}): MigrateResult {
  const home = reasonixHome(opts);
  const dryRun = opts.dryRun ?? false;
  const requested = opts.only ?? SUBSYSTEMS;
  const db = opts.db ?? getDb(join(home, "reasonix.db"));

  const lockPath = dryRun ? null : acquireLock(home);
  try {
    const already = dryRun ? new Set<string>() : migratedSet(db);
    const subsystems: SubsystemResult[] = [];
    for (const name of requested) {
      if (already.has(name)) {
        subsystems.push({ name, count: 0, skipped: true });
        continue;
      }
      const count = MIGRATORS[name](db, home, dryRun);
      if (!dryRun) recordMigration(db, name, count);
      subsystems.push({ name, count, skipped: false });
    }

    let activated = false;
    if (opts.activate && !dryRun) {
      setStoreBackend("sqlite", home);
      activated = true;
    }
    return { subsystems, activated, dryRun };
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

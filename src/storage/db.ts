import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { reasonixDbPath, secureDbFile } from "./path.js";
import { migrate } from "./schema.js";

const BUSY_RETRY_MAX = 5;
const BUSY_RETRY_BASE_MS = 10;
const BUSY_RETRY_CAP_MS = 200;

export interface Db {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  tx<T>(fn: () => T): T;
  withBusyRetry<T>(fn: () => T): T;
  close(): void;
  readonly raw: DatabaseSync;
  readonly journalMode: string;
}

let warningFilterInstalled = false;

function installExperimentalWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning;
  // node:sqlite emits a code-less ExperimentalWarning at module load. The
  // authoritative mute is the CLI entry flag --disable-warning=ExperimentalWarning;
  // this is the library-level best-effort. A bare name match would also swallow
  // unrelated ExperimentalWarnings, so narrow by message (the warning carries no code).
  const patched = function (this: unknown, ...args: unknown[]): void {
    const [warning, second] = args;
    const name =
      warning instanceof Error
        ? warning.name
        : typeof second === "string"
          ? second
          : (second as { type?: string } | undefined)?.type;
    const message = warning instanceof Error ? warning.message : String(warning);
    if (name === "ExperimentalWarning" && /sqlite/i.test(message)) return;
    (original as (...a: unknown[]) => void).apply(this, args);
  };
  process.emitWarning = patched as typeof process.emitWarning;
}

function isBusyError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(e.message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function openDb(path: string): Db {
  installExperimentalWarningFilter();
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);

  // auto_vacuum must be set before any table exists (build-time only).
  raw.exec("PRAGMA auto_vacuum=INCREMENTAL");
  // WAL + busy_timeout must be set outside any transaction. journal_mode is read
  // back because a non-local FS silently refuses WAL and falls back to a rollback
  // journal (NF-006) — that is correct, just less concurrent.
  const journalRow = raw.prepare("PRAGMA journal_mode=WAL").get() as
    | { journal_mode?: string }
    | undefined;
  raw.exec("PRAGMA busy_timeout=5000");
  raw.exec("PRAGMA foreign_keys=ON");
  raw.exec("PRAGMA synchronous=NORMAL");
  secureDbFile(path);

  const journalMode = journalRow?.journal_mode?.toLowerCase() ?? "unknown";
  const stmtCache = new Map<string, StatementSync>();

  const db: Db = {
    raw,
    journalMode,
    prepare(sql) {
      let s = stmtCache.get(sql);
      if (!s) {
        s = raw.prepare(sql);
        stmtCache.set(sql, s);
      }
      return s;
    },
    exec(sql) {
      raw.exec(sql);
    },
    tx(fn) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* rollback best-effort; the original error is the one to surface */
        }
        throw e;
      }
    },
    withBusyRetry(fn) {
      let delay = BUSY_RETRY_BASE_MS;
      for (let attempt = 0; ; attempt++) {
        try {
          return fn();
        } catch (e) {
          if (attempt >= BUSY_RETRY_MAX || !isBusyError(e)) throw e;
          sleepSync(delay);
          delay = Math.min(delay * 2, BUSY_RETRY_CAP_MS);
        }
      }
    },
    close() {
      stmtCache.clear();
      raw.close();
    },
  };

  migrate(db);
  return db;
}

let singleton: Db | null = null;

export function getDb(path?: string): Db {
  if (!singleton) singleton = openDb(path ?? reasonixDbPath());
  return singleton;
}

export function resetDb(): void {
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { reasonixDbPath, secureDbFile } from "./path.js";
import { migrate } from "./schema.js";

// node:sqlite is loaded through createRequire (a runtime require) instead of a static
// import. esbuild is too new-builtin-blind to keep `node:sqlite`: a static import gets
// rewritten to an unresolvable bare `sqlite` (ERR_MODULE_NOT_FOUND in the bundled lib —
// `require("sqlite")` does NOT resolve the builtin, only `require("node:sqlite")` does).
// A runtime require resolves the builtin natively at load — verified for both the lib
// (dist/index.js) and CLI (dist/cli) bundles by tests/bundle-smoke.test.ts. The
// type-only import above is erased at build yet keeps db.ts the sole node:sqlite
// textual reference (C-001).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const BUSY_RETRY_MAX = 5;
const BUSY_RETRY_BASE_MS = 10;
const BUSY_RETRY_CAP_MS = 200;

export interface Db {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  tx<T>(fn: () => T): T;
  withBusyRetry<T>(fn: () => T): T;
  close(): void;
  readonly raw: InstanceType<typeof DatabaseSync>;
  readonly journalMode: string;
  /** Absolute path this db was opened against (FR-016 path-correctness guard). */
  readonly path: string;
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
    path,
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
let exitHookInstalled = false;

// FR-015 exit checkpoint: useQuit.quitProcess calls process.exit(0), bypassing
// Ink's cleanup, which would lose the last turn's un-checkpointed WAL frames.
// One sync handler (registered once on first open) closes whatever singleton is
// still open at exit — close() checkpoints the WAL. A no-op after resetDb()
// nulls the singleton, which keeps it safe under vitest (one process, many
// db.ts importers): it only ever closes a still-open singleton.
function installExitCheckpoint(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (!singleton) return;
    try {
      singleton.close();
    } catch {
      /* exit-time best-effort — nothing left to recover to */
    }
    singleton = null;
  });
}

export function getDb(path?: string): Db {
  if (singleton) {
    // FR-016: an explicit, different path must never silently inspect/return the
    // already-open db (e.g. doctor passing a path that isn't the app's). Callers
    // that legitimately switch paths reset() first.
    if (path !== undefined && path !== singleton.path) {
      throw new Error(
        `getDb(${path}) requested but the singleton is already open on ${singleton.path} — call resetDb() before switching paths`,
      );
    }
    return singleton;
  }
  installExitCheckpoint();
  singleton = openDb(path ?? reasonixDbPath());
  return singleton;
}

export function resetDb(): void {
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

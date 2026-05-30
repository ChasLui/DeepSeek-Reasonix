import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SqliteMemoryStore } from "../adapters/memory-store-sqlite.js";
import {
  type MemoryEntry,
  type MemoryPriority,
  type MemoryScope,
  sanitizeMemoryName,
} from "./user.js";

export interface AccessStats {
  lastAccessedAt: string;
  accessCount: number;
}

export interface AccessOptions {
  homeDir?: string;
}

export interface ForgetOptions {
  minScore: number;
  scope?: MemoryScope;
  dryRun?: boolean;
  halflifeDays?: number;
  now?: Date;
}

export interface ForgetCandidate {
  entry: MemoryEntry;
  decayScore: number;
  lastAccessedAt: string;
  action: "preview" | "soft-delete";
  trashPath?: string;
}

export interface ForgetResult {
  previewed: number;
  softDeleted: number;
  candidates: ForgetCandidate[];
}

export interface PurgeOptions {
  olderThanDays?: number;
  ciGuard?: boolean;
  now?: Date;
}

export interface PurgeResult {
  hardDeleted: number;
}

const ACCESS_FILE = ".access.jsonl";
const TRASH_DIR = ".trash";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function memoryRootFromHome(homeDir: string = join(homedir(), ".reasonix")): string {
  return join(homeDir, "memory");
}

export function appendAccess(
  scope: MemoryScope,
  rawName: string,
  ts: number | Date = Date.now(),
  opts: AccessOptions = {},
): void {
  const name = sanitizeMemoryName(rawName);
  const root = memoryRootFromHome(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const iso = new Date(ts).toISOString();
  appendFileSync(join(root, ACCESS_FILE), `${JSON.stringify({ ts: iso, scope, name })}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

export function loadAccessStats(opts: AccessOptions = {}): Map<string, AccessStats> {
  const file = join(memoryRootFromHome(opts.homeDir), ACCESS_FILE);
  const stats = new Map<string, AccessStats>();
  if (!existsSync(file)) return stats;
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseAccessLine(trimmed);
    if (!parsed) {
      console.warn("skipping malformed memory access sidecar line");
      continue;
    }
    const key = accessKey(parsed.scope, parsed.name);
    const previous = stats.get(key);
    if (!previous) {
      stats.set(key, { lastAccessedAt: parsed.ts, accessCount: 1 });
      continue;
    }
    previous.accessCount += 1;
    if (Date.parse(parsed.ts) > Date.parse(previous.lastAccessedAt)) {
      previous.lastAccessedAt = parsed.ts;
    }
  }
  return stats;
}

export function computeDecayScore(
  entry: MemoryEntry,
  stats: AccessStats | undefined,
  now: Date = new Date(),
  halflifeDays = 30,
): number {
  const lastAccessedAt = stats?.lastAccessedAt ?? entry.createdAt;
  const last = Date.parse(lastAccessedAt);
  const ageDays = Number.isFinite(last) ? Math.max(0, (now.getTime() - last) / MS_PER_DAY) : 0;
  const priority = priorityWeight(entry.priority);
  const accessCount = stats?.accessCount ?? 0;
  const halfLife = Math.max(1, halflifeDays);
  return Math.exp(-ageDays / halfLife) * priority * Math.log1p(accessCount + priority);
}

export function forget(store: SqliteMemoryStore, opts: ForgetOptions): ForgetResult {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const root = memoryRootFromStore(store);
  const stats = loadAccessStats({ homeDir: dirname(root) });
  const candidates: ForgetCandidate[] = [];
  let softDeleted = 0;

  for (const entry of store.list()) {
    if (opts.scope && entry.scope !== opts.scope) continue;
    const access = stats.get(accessKey(entry.scope, entry.name));
    const score = computeDecayScore(entry, access, now, opts.halflifeDays);
    if (score >= opts.minScore) continue;

    const lastAccessedAt = access?.lastAccessedAt ?? entry.createdAt;
    const candidate: ForgetCandidate = {
      entry,
      decayScore: score,
      lastAccessedAt,
      action: dryRun ? "preview" : "soft-delete",
    };

    if (!dryRun) {
      // No source file under SQLite — materialize the row to the same Markdown the
      // file backend wrote so trash stays human-recoverable, then drop the row.
      const md = store.exportMarkdown(entry.scope, entry.name);
      if (md !== null) {
        const trashPath = uniqueTrashPath(root, entry.name, now);
        mkdirSync(dirname(trashPath), { recursive: true });
        writeFileSync(trashPath, md, "utf8");
        if (store.delete(entry.scope, entry.name)) softDeleted += 1;
        candidate.trashPath = trashPath;
      }
    }
    candidates.push(candidate);
  }

  return { previewed: candidates.length, softDeleted, candidates };
}

export function purge(store: SqliteMemoryStore, opts: PurgeOptions = {}): PurgeResult {
  if (opts.ciGuard !== false && /^true$/i.test(process.env.CI ?? "")) {
    throw new Error("refusing to purge memory trash while CI=true");
  }
  const root = memoryRootFromStore(store);
  const trash = join(root, TRASH_DIR);
  if (!existsSync(trash)) return { hardDeleted: 0 };
  const now = opts.now ?? new Date();
  const cutoff =
    opts.olderThanDays === undefined
      ? Number.POSITIVE_INFINITY
      : now.getTime() - opts.olderThanDays * MS_PER_DAY;
  let hardDeleted = 0;
  for (const file of readdirSync(trash)) {
    if (!file.endsWith(".md")) continue;
    const full = join(trash, basename(file));
    if (opts.olderThanDays !== undefined && statSync(full).mtimeMs > cutoff) continue;
    rmSync(full, { force: true });
    hardDeleted += 1;
  }
  return { hardDeleted };
}

export function accessKey(scope: MemoryScope, name: string): string {
  return `${scope}/${sanitizeMemoryName(name)}`;
}

function parseAccessLine(line: string): { ts: string; scope: MemoryScope; name: string } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { ts?: unknown; scope?: unknown; name?: unknown };
    if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) return null;
    if (value.scope !== "global" && value.scope !== "project") return null;
    if (typeof value.name !== "string") return null;
    return {
      ts: value.ts,
      scope: value.scope,
      name: sanitizeMemoryName(value.name),
    };
  } catch {
    return null;
  }
}

function priorityWeight(priority: MemoryPriority | undefined): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function memoryRootFromStore(store: SqliteMemoryStore): string {
  return dirname(store.dir("global"));
}

function uniqueTrashPath(root: string, name: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const safeName = sanitizeMemoryName(name);
  const base = join(root, TRASH_DIR, `${stamp}-${safeName}.md`);
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = join(root, TRASH_DIR, `${stamp}-${safeName}-${i}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate trash path for ${safeName}`);
}

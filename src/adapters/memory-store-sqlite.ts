import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type MemoryEntry,
  type MemoryScope,
  type MemoryType,
  USER_MEMORY_DIR,
  type WriteInput,
  sanitizeMemoryName,
} from "../memory/user.js";
import type { Db } from "../storage/db.js";

// Mirrors user.ts MEMORY_INDEX_MAX_CHARS / indexLine / formatFrontmatter / projectHash
// exactly so applyUserMemory produces a byte-identical prefix block (SC-003). projectHash
// is re-derived (not imported) to keep this adapter off user.ts's value graph — user.ts
// imports SqliteMemoryStore, so a value import back would cycle.
const MEMORY_INDEX_MAX_CHARS = 4000;

function projectHashOf(rootDir: string): string {
  return createHash("sha1").update(resolve(rootDir)).digest("hex").slice(0, 16);
}

function indexLine(e: Pick<MemoryEntry, "name" | "description">): string {
  const safeDesc = e.description.replace(/\n/g, " ").trim();
  const max = 130 - e.name.length;
  const clipped = safeDesc.length > max ? `${safeDesc.slice(0, Math.max(1, max - 1))}…` : safeDesc;
  return `- [${e.name}](${e.name}.md) — ${clipped}`;
}

function formatFrontmatter(e: MemoryEntry): string {
  const lines = [
    "---",
    `name: ${e.name}`,
    `description: ${e.description.replace(/\n/g, " ")}`,
    `type: ${e.type}`,
    `scope: ${e.scope}`,
    `created: ${e.createdAt}`,
  ];
  if (e.priority) lines.push(`priority: ${e.priority}`);
  if (e.expires) lines.push(`expires: ${e.expires}`);
  lines.push("---", "");
  return lines.join("\n");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function coercePriority(v: unknown): MemoryEntry["priority"] | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

function coerceExpires(v: unknown): MemoryEntry["expires"] | undefined {
  return v === "project_end" ? v : undefined;
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const entry: MemoryEntry = {
    name: String(row.name),
    type: String(row.type) as MemoryType,
    scope: String(row.scope) as MemoryScope,
    description: String(row.description),
    body: String(row.body),
    createdAt: String(row.created_at),
  };
  const priority = coercePriority(row.priority);
  if (priority) entry.priority = priority;
  const expires = coerceExpires(row.expires);
  if (expires) entry.expires = expires;
  return entry;
}

// SQLite-backed memory store. Sync drop-in for the (deleted) file MemoryStore at every
// read/write site (Db is synchronous), so write/read/delete/list/loadIndex mirror the file
// API. Memory CONTENT lives in the `memory` table; only recovery sidecars (.access.jsonl,
// .trash/, .observations.jsonl, .index/) stay on disk — never part of the immutable prefix.
export class SqliteMemoryStore {
  private readonly projectHashValue: string;
  private readonly homeDir: string;
  private readonly projectRoot: string | undefined;

  constructor(
    private readonly db: Db,
    projectRoot?: string,
    homeDir?: string,
  ) {
    this.projectRoot = projectRoot ? resolve(projectRoot) : undefined;
    this.projectHashValue = this.projectRoot ? projectHashOf(this.projectRoot) : "";
    this.homeDir = homeDir ?? join(homedir(), ".reasonix");
  }

  private hashFor(scope: MemoryScope): string {
    return scope === "project" ? this.projectHashValue : "";
  }

  hasProjectScope(): boolean {
    return this.projectRoot !== undefined;
  }

  // Filesystem dir the sidecars (access/observation/trash/index) hang off — content lives
  // in SQLite, but the sidecars still need a stable per-scope path.
  dir(scope: MemoryScope): string {
    if (scope === "project") {
      if (!this.projectRoot) throw new Error("scope=project requires a projectRoot on MemoryStore");
      return join(this.homeDir, USER_MEMORY_DIR, this.projectHashValue);
    }
    return join(this.homeDir, USER_MEMORY_DIR, "global");
  }

  /** Synthetic path identifier (no file is created); mirrors the file store's `write` return. */
  pathFor(scope: MemoryScope, name: string): string {
    return join(this.dir(scope), `${sanitizeMemoryName(name)}.md`);
  }

  /** Root the on-disk sidecars (`.observations.jsonl`, `.access.jsonl`, …) live under. */
  memoryRoot(): string {
    return join(this.homeDir, USER_MEMORY_DIR);
  }

  /** Write a memory row, preserving priority/expires; stamps created_at = today. Returns a synthetic path. */
  write(input: WriteInput): string {
    if (input.scope === "project" && !this.projectRoot) {
      throw new Error("cannot write project-scoped memory: no projectRoot configured");
    }
    const name = sanitizeMemoryName(input.name);
    const description = String(input.description ?? "").trim();
    if (!description) throw new Error("memory description cannot be empty");
    const body = String(input.body ?? "").trim();
    if (!body) throw new Error("memory body cannot be empty");
    this.db.withBusyRetry(() =>
      this.db
        .prepare(
          "INSERT INTO memory (scope, project_hash, name, type, description, body, created_at, priority, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, project_hash, name) DO UPDATE SET type = excluded.type, description = excluded.description, body = excluded.body, created_at = excluded.created_at, priority = excluded.priority, expires = excluded.expires",
        )
        .run(
          input.scope,
          this.hashFor(input.scope),
          name,
          input.type,
          description,
          body,
          todayIso(),
          input.priority ?? null,
          input.expires ?? null,
        ),
    );
    this.markSearchIndexStale();
    return this.pathFor(input.scope, name);
  }

  // Flags the BM25/semantic index for rebuild — same `.stale` sidecar the file backend
  // wrote on every mutation, so `reasonix memory search` still knows when it's out of date.
  private markSearchIndexStale(): void {
    const root = join(this.memoryRoot(), ".index");
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".stale"), "true\n", "utf8");
  }

  /** Read one memory; throws if missing (parity with the file store's `read`). */
  read(scope: MemoryScope, name: string): MemoryEntry {
    const entry = this.query(scope, sanitizeMemoryName(name));
    if (!entry) throw new Error(`memory not found: scope=${scope} name=${name}`);
    return entry;
  }

  query(scope: MemoryScope, name: string): MemoryEntry | null {
    const row = this.db
      .prepare("SELECT * FROM memory WHERE scope = ? AND project_hash = ? AND name = ?")
      .get(scope, this.hashFor(scope), name);
    return row ? rowToEntry(row as Record<string, unknown>) : null;
  }

  /** All entries across the store's scopes (global, plus project when configured). */
  list(): MemoryEntry[] {
    return this.listEntriesSync();
  }

  /** Delete one memory row. Returns false if nothing matched (idempotent). */
  delete(scope: MemoryScope, name: string): boolean {
    if (scope === "project" && !this.projectRoot) {
      throw new Error("cannot delete project-scoped memory: no projectRoot configured");
    }
    const changes = Number(
      this.db
        .prepare("DELETE FROM memory WHERE scope = ? AND project_hash = ? AND name = ?")
        .run(scope, this.hashFor(scope), sanitizeMemoryName(name)).changes,
    );
    if (changes > 0) this.markSearchIndexStale();
    return changes > 0;
  }

  /** Alias kept for the storage-memory test's port-shaped assertions. */
  remove(scope: MemoryScope, name: string): boolean {
    return this.delete(scope, name);
  }

  // Synchronous over the store's scopes (global, plus project when configured) so the
  // synchronous applyUserMemory can read the prefix without going async.
  listEntriesSync(): MemoryEntry[] {
    const rows = this.projectHashValue
      ? this.db
          .prepare(
            "SELECT * FROM memory WHERE (scope = 'global' AND project_hash = '') OR (scope = 'project' AND project_hash = ?)",
          )
          .all(this.projectHashValue)
      : this.db.prepare("SELECT * FROM memory WHERE scope = 'global' AND project_hash = ''").all();
    return (rows as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** Alias to loadIndexContent — matches the file store's `loadIndex` method name at call sites. */
  loadIndex(
    scope: MemoryScope,
  ): { content: string; originalChars: number; truncated: boolean } | null {
    return this.loadIndexContent(scope);
  }

  // Byte-identical to user.ts MemoryStore.loadIndex (regenerateIndex's `${name}.md`-keyed
  // localeCompare sort + indexLine + the 4000-char cap), so the prefix block is stable and
  // independent of row insertion order (SC-003).
  loadIndexContent(
    scope: MemoryScope,
  ): { content: string; originalChars: number; truncated: boolean } | null {
    if (scope === "project" && !this.projectRoot) return null;
    const rows = this.db
      .prepare("SELECT name, description FROM memory WHERE scope = ? AND project_hash = ?")
      .all(scope, this.hashFor(scope)) as Array<{
      name: string;
      description: string;
    }>;
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => `${a.name}.md`.localeCompare(`${b.name}.md`));
    const trimmed = sorted
      .map((e) => indexLine(e))
      .join("\n")
      .trim();
    if (!trimmed) return null;
    const originalChars = trimmed.length;
    const truncated = originalChars > MEMORY_INDEX_MAX_CHARS;
    const content = truncated
      ? `${trimmed.slice(0, MEMORY_INDEX_MAX_CHARS)}\n… (truncated ${originalChars - MEMORY_INDEX_MAX_CHARS} chars)`
      : trimmed;
    return { content, originalChars, truncated };
  }

  // git-diff readability rescue (FR-021): materialize a row back to the exact
  // Markdown + YAML frontmatter the file backend would have written.
  exportMarkdown(scope: MemoryScope, name: string): string | null {
    const entry = this.query(scope, sanitizeMemoryName(name));
    if (!entry) return null;
    return `${formatFrontmatter(entry)}${entry.body}\n`;
  }
}

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { MemoryEntry, MemoryScope, MemoryType } from "../memory/user.js";
import type { MemoryStore, MemoryWriteInput } from "../ports/memory-store.js";
import type { Db } from "../storage/db.js";

// Mirrors user.ts MEMORY_INDEX_MAX_CHARS / indexLine / formatFrontmatter / projectHash
// exactly so applyUserMemory produces a byte-identical prefix block regardless of
// backend. SC-003 is the drift guard: if user.ts changes its rendering, that test
// fails. projectHash is re-derived (not imported) to keep this adapter off user.ts's
// value graph — user.ts imports SqliteMemoryStore, so a value import back would cycle.
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

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const entry: MemoryEntry = {
    name: String(row.name),
    type: String(row.type) as MemoryType,
    scope: String(row.scope) as MemoryScope,
    description: String(row.description),
    body: String(row.body),
    createdAt: String(row.created_at),
  };
  if (row.priority !== null && row.priority !== undefined) {
    entry.priority = String(row.priority) as MemoryEntry["priority"];
  }
  if (row.expires !== null && row.expires !== undefined) {
    entry.expires = String(row.expires) as MemoryEntry["expires"];
  }
  return entry;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly projectHashValue: string;

  constructor(
    private readonly db: Db,
    projectRoot?: string,
  ) {
    this.projectHashValue = projectRoot ? projectHashOf(projectRoot) : "";
  }

  private hashFor(scope: MemoryScope): string {
    return scope === "project" ? this.projectHashValue : "";
  }

  hasProjectScope(): boolean {
    return this.projectHashValue !== "";
  }

  async query(scope: MemoryScope, name: string): Promise<MemoryEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM memory WHERE scope = ? AND project_hash = ? AND name = ?")
      .get(scope, this.hashFor(scope), name);
    return row ? rowToEntry(row as Record<string, unknown>) : null;
  }

  async list(scope: MemoryScope): Promise<ReadonlyArray<MemoryEntry>> {
    const rows = this.db
      .prepare("SELECT * FROM memory WHERE scope = ? AND project_hash = ?")
      .all(scope, this.hashFor(scope)) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  // Synchronous counterpart to user.ts MemoryStore.list() — same scope set
  // (global, plus project when configured) — so applyUserMemory (synchronous)
  // can gate between backends without going async.
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

  async write(input: MemoryWriteInput): Promise<void> {
    this.db.withBusyRetry(() =>
      this.db
        .prepare(
          "INSERT INTO memory (scope, project_hash, name, type, description, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, project_hash, name) DO UPDATE SET type = excluded.type, description = excluded.description, body = excluded.body, created_at = excluded.created_at",
        )
        .run(
          input.scope,
          this.hashFor(input.scope),
          input.name,
          input.type,
          input.description,
          input.body,
          todayIso(),
        ),
    );
  }

  async remove(scope: MemoryScope, name: string): Promise<boolean> {
    const changes = Number(
      this.db
        .prepare("DELETE FROM memory WHERE scope = ? AND project_hash = ? AND name = ?")
        .run(scope, this.hashFor(scope), name).changes,
    );
    return changes > 0;
  }

  // Byte-identical to user.ts MemoryStore.loadIndex (regenerateIndex's
  // `${name}.md`-keyed localeCompare sort + indexLine + the 4000-char cap), so the
  // prefix block matches the file backend after cutover (SC-003).
  loadIndexContent(
    scope: MemoryScope,
  ): { content: string; originalChars: number; truncated: boolean } | null {
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
    const row = this.db
      .prepare("SELECT * FROM memory WHERE scope = ? AND project_hash = ? AND name = ?")
      .get(scope, this.hashFor(scope), name);
    if (!row) return null;
    const entry = rowToEntry(row as Record<string, unknown>);
    return `${formatFrontmatter(entry)}${entry.body}\n`;
  }
}

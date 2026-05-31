/** tool_catalog repo (FR-002): SQLite read/write for the deferred catalog — a
 *  pure derived index, fails soft (NF-005); embedding = packed Float32 BLOB. */

import type { Db } from "./db.js";

export interface ToolCatalogRow {
  /** "builtin" | `mcp:${server}` | "skill" */
  source: string;
  name: string;
  description: string;
  /** flatSchema ?? parameters, JSON.stringify'd — same shape specs() exposes. */
  paramsJson: string;
  /** 0 = essential/常驻, 1 = warm, 2 = deferred. */
  tier: number;
  /** Packed Float32 vector, or null when not yet computed. */
  embedding?: Float32Array | null;
}

const UPSERT_SQL =
  "INSERT OR REPLACE INTO tool_catalog (source, name, description, params_json, tier, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

function packEmbedding(v: Float32Array | null | undefined): Uint8Array | null {
  if (!v || v.length === 0) return null;
  // Copy into a standalone buffer — the source may be a view over a larger
  // ArrayBuffer (e.g. a batch alloc); never persist a shared backing store.
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

function unpackEmbedding(blob: unknown): Float32Array | null {
  if (blob == null) return null;
  const u8 = blob instanceof Uint8Array ? blob : null;
  if (!u8 || u8.byteLength === 0 || u8.byteLength % 4 !== 0) return null;
  // Copy so the Float32 view owns its bytes (sqlite may reuse the row buffer).
  const copy = u8.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Upsert catalog rows in one tx. Used by buildToolCatalog on startup/rebuild. */
export function upsertToolCatalog(db: Db, rows: readonly ToolCatalogRow[]): void {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  db.withBusyRetry(() =>
    db.tx(() => {
      const stmt = db.prepare(UPSERT_SQL);
      for (const r of rows) {
        stmt.run(
          r.source,
          r.name,
          r.description,
          r.paramsJson,
          r.tier,
          packEmbedding(r.embedding),
          now,
        );
      }
    }),
  );
}

export interface ListFilter {
  source?: string;
  tier?: number;
}

function rowToCatalog(row: Record<string, unknown>): ToolCatalogRow {
  return {
    source: String(row.source),
    name: String(row.name),
    description: String(row.description),
    paramsJson: String(row.params_json),
    tier: Number(row.tier),
    embedding: unpackEmbedding(row.embedding),
  };
}

/** Read catalog rows. Fails soft (returns []) — catalog is rebuildable (NF-005). */
export function listToolCatalog(db: Db, filter: ListFilter = {}): ToolCatalogRow[] {
  try {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.source !== undefined) {
      where.push("source = ?");
      args.push(filter.source);
    }
    if (filter.tier !== undefined) {
      where.push("tier = ?");
      args.push(filter.tier);
    }
    const sql = `SELECT source, name, description, params_json, tier, embedding FROM tool_catalog${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    }`;
    return db
      .prepare(sql)
      .all(...args)
      .map((r) => rowToCatalog(r as Record<string, unknown>));
  } catch {
    return [];
  }
}

/** Lazy-embedding read for a single tool. null when absent or on error. */
export function getToolEmbedding(db: Db, source: string, name: string): Float32Array | null {
  try {
    const row = db
      .prepare("SELECT embedding FROM tool_catalog WHERE source = ? AND name = ?")
      .get(source, name) as Record<string, unknown> | undefined;
    return row ? unpackEmbedding(row.embedding) : null;
  } catch {
    return null;
  }
}

/** Fill the embedding column after lazy computation (NF-003). */
export function setToolEmbedding(
  db: Db,
  source: string,
  name: string,
  embedding: Float32Array,
): void {
  db.withBusyRetry(() =>
    db
      .prepare("UPDATE tool_catalog SET embedding = ? WHERE source = ? AND name = ?")
      .run(packEmbedding(embedding), source, name),
  );
}

/** Drop all rows — used before a full rebuild (NF-005). */
export function clearToolCatalog(db: Db): void {
  db.withBusyRetry(() => db.prepare("DELETE FROM tool_catalog").run());
}

/** Count rows grouped by source — backs the `/tools` command (FR-008). */
export function countToolCatalogBySource(db: Db): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const row of db
      .prepare("SELECT source, COUNT(*) AS n FROM tool_catalog GROUP BY source")
      .all()) {
      const r = row as Record<string, unknown>;
      out.set(String(r.source), Number(r.n));
    }
  } catch {
    /* fail soft */
  }
  return out;
}

/** Tool catalog behind search_tools (FR-002/003): bm25 lexical + lazy semantic
 *  cosine fused by RRF; rebuildable projection of the ToolRegistry (NF-005). */

import { Bm25Index } from "../index/lexical/bm25.js";
import type { Db } from "../storage/db.js";
import { type ToolCatalogRow, upsertToolCatalog } from "../storage/tool-catalog-repo.js";
import type { ToolSpec } from "../types.js";

/** Lowercase alphanumeric word split — shared by indexing and querying. */
export function tokenizeForCatalog(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface CatalogToolInput {
  /** "builtin" | `mcp:${server}` | "skill" */
  source: string;
  /** 0 essential / 1 warm / 2 deferred. */
  tier: number;
  spec: ToolSpec;
}

export interface ToolSearchHit {
  source: string;
  name: string;
  description: string;
  /** required + top-level property names — never drops a required arg (FR-003). */
  paramsSummary: string;
  score: number;
}

const KEY_SEP = " ";
const keyOf = (source: string, name: string): string => `${source}${KEY_SEP}${name}`;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/** required[] + Object.keys(properties) as a stable one-line summary. */
function summarizeParams(paramsJson: string): string {
  try {
    const p = JSON.parse(paramsJson) as {
      required?: unknown;
      properties?: Record<string, unknown>;
    };
    const required = Array.isArray(p.required) ? p.required.map(String) : [];
    const props = p.properties && typeof p.properties === "object" ? Object.keys(p.properties) : [];
    const optional = props.filter((k) => !required.includes(k));
    const parts: string[] = [];
    if (required.length) parts.push(`required: ${required.join(", ")}`);
    if (optional.length) parts.push(`optional: ${optional.join(", ")}`);
    return parts.join("; ");
  } catch {
    return "";
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Reciprocal Rank Fusion (FR-003 default) — combine ranked key lists. */
function rrf(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranked of rankings) {
    ranked.forEach((key, idx) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return scores;
}

/** Optional async embedder: text → vector. Mirrors index/semantic/embedding.embed. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

export class ToolCatalog {
  private readonly bm25 = new Bm25Index();
  private readonly rows = new Map<string, ToolCatalogRow>();
  /** Lazily-filled query-time cache of tool vectors (NF-003). */
  private readonly vectors = new Map<string, Float32Array>();

  private constructor() {}

  /** Build from a full registry snapshot (FR-002): bm25 in-memory + best-effort
   *  SQLite upsert. db=null → memory-only (tests). */
  static build(tools: readonly CatalogToolInput[], db: Db | null = null): ToolCatalog {
    const cat = new ToolCatalog();
    const persistRows: ToolCatalogRow[] = [];
    for (const t of tools) {
      const name = t.spec.function?.name;
      if (!name) continue;
      const description = t.spec.function?.description ?? "";
      const paramsJson = JSON.stringify(t.spec.function?.parameters ?? { type: "object" });
      const key = keyOf(t.source, name);
      const row: ToolCatalogRow = {
        source: t.source,
        name,
        description,
        paramsJson,
        tier: t.tier,
      };
      cat.rows.set(key, row);
      // Weight the tool name 2x (most signal), then description, then param names.
      const nameTokens = tokenizeForCatalog(name);
      cat.bm25.add(key, [
        ...nameTokens,
        ...nameTokens,
        ...tokenizeForCatalog(description),
        ...tokenizeForCatalog(summarizeParams(paramsJson)),
      ]);
      persistRows.push(row);
    }
    if (db) {
      try {
        upsertToolCatalog(db, persistRows);
      } catch {
        /* catalog is rebuildable (NF-005) — persistence is best-effort */
      }
    }
    return cat;
  }

  get size(): number {
    return this.rows.size;
  }

  private hitOf(key: string, score: number): ToolSearchHit | null {
    const r = this.rows.get(key);
    if (!r) return null;
    return {
      source: r.source,
      name: r.name,
      description: r.description,
      paramsSummary: summarizeParams(r.paramsJson),
      score,
    };
  }

  /** Synchronous lexical search (NF-002): always returns, no provider needed. */
  search(query: string, limit = 8): ToolSearchHit[] {
    const k = clamp(limit, 1, 20);
    const hits = this.bm25.search(tokenizeForCatalog(query), k);
    const out: ToolSearchHit[] = [];
    for (const h of hits) {
      const hit = this.hitOf(h.docId, h.score);
      if (hit) out.push(hit);
    }
    return out;
  }

  /** Hybrid search (FR-003): bm25 ∪ cosine fused by RRF; degrades to pure bm25
   *  when no embedder is supplied or embedding throws (NF-002 fallback). */
  async searchHybrid(query: string, limit = 8, embedFn?: EmbedFn): Promise<ToolSearchHit[]> {
    const k = clamp(limit, 1, 20);
    const over = k * 2;
    const bmKeys = this.bm25.search(tokenizeForCatalog(query), over).map((h) => h.docId);

    if (!embedFn) return this.search(query, k);

    let cosKeys: string[] = [];
    try {
      const qv = await embedFn(query);
      const scored: Array<{ key: string; s: number }> = [];
      for (const [key, row] of this.rows) {
        const v = await this.vectorFor(key, row, embedFn);
        if (v) scored.push({ key, s: cosine(qv, v) });
      }
      scored.sort((a, b) => b.s - a.s);
      cosKeys = scored.slice(0, over).map((x) => x.key);
    } catch {
      return this.search(query, k); // provider failed → bm25-only
    }

    const fused = rrf([bmKeys, cosKeys]);
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    const out: ToolSearchHit[] = [];
    for (const [key, score] of ranked) {
      const hit = this.hitOf(key, score);
      if (hit) out.push(hit);
    }
    return out;
  }

  private async vectorFor(
    key: string,
    row: ToolCatalogRow,
    embedFn: EmbedFn,
  ): Promise<Float32Array | null> {
    const cached = this.vectors.get(key) ?? row.embedding;
    if (cached) {
      this.vectors.set(key, cached);
      return cached;
    }
    try {
      const text = `${row.name}\n${row.description}\n${summarizeParams(row.paramsJson)}`;
      const v = await embedFn(text);
      this.vectors.set(key, v);
      return v;
    } catch {
      return null;
    }
  }
}

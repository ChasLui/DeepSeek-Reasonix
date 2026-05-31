// Pillar 5 unified code retrieval (FR-002). Composes bm25 + semantic + graph
// behind fuseRrf with canonical-docId projection (FR-008) and graceful
// degradation: bm25 is always-on, semantic/graph are additive and best-effort.

import { findReferences } from "../../code-query/relations.js";
import { segmentCjk } from "../cjk/segment.js";
import { type RankedHit, fuseRrf } from "../hybrid/fuse.js";
import { openOrBuildCodeLexicalIndex } from "../lexical/code.js";
import { querySemantic } from "../semantic/builder.js";
import {
  type ChunkMap,
  type ChunkRange,
  type RetrievalHit,
  type RetrievalSource,
  canonicalCodeDocId,
  isSymbolLike,
  parseCanonicalDocId,
  relationRecordToChunkId,
} from "./types.js";

export interface RetrieveOptions {
  topK?: number;
  semantic?: boolean;
  graph?: boolean;
}

export interface RetrieveResult {
  hits: RetrievalHit[];
  sourcesUsed: RetrievalSource[];
  notes: string[];
}

interface HitMeta {
  path: string;
  startLine: number;
  endLine: number;
  sources: Set<RetrievalSource>;
  fusible: boolean;
  snippet?: string;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export async function retrieveCode(
  root: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = clamp(opts.topK ?? 8, 1, 50);
  const perSource = Math.max(topK * 3, 24);
  const tokens = segmentCjk(query);
  const rankings: RankedHit[][] = [];
  const notes: string[] = [];
  const sourcesUsed: RetrievalSource[] = [];
  const meta = new Map<string, HitMeta>();

  const touch = (docId: string, m: Omit<HitMeta, "sources">, source: RetrievalSource): void => {
    const existing = meta.get(docId);
    if (existing) {
      existing.sources.add(source);
      if (!existing.snippet && m.snippet) existing.snippet = m.snippet;
    } else {
      meta.set(docId, { ...m, sources: new Set([source]) });
    }
  };

  // BM25 over code chunks (always-on, FR-005).
  try {
    const index = await openOrBuildCodeLexicalIndex(root);
    if (index) {
      const hits = index.search(tokens, perSource);
      const ranking: RankedHit[] = [];
      for (const h of hits) {
        const parsed = parseCanonicalDocId(h.docId);
        if (!parsed) continue;
        touch(h.docId, { ...parsed, fusible: true }, "bm25");
        ranking.push({ docId: h.docId, score: h.score });
      }
      if (ranking.length > 0) {
        rankings.push(ranking);
        sourcesUsed.push("bm25");
      }
    } else {
      notes.push("lexical index unavailable — run `reasonix index --lexical-only`");
    }
  } catch {
    notes.push("bm25 retrieval failed");
  }

  // Semantic cosine (additive; skipped without an embedder/index).
  if (opts.semantic !== false) {
    try {
      const hits = await querySemantic(root, query, { topK: perSource });
      if (hits && hits.length > 0) {
        const ranking: RankedHit[] = [];
        for (const h of hits) {
          const { path, startLine, endLine, text } = h.entry;
          const docId = canonicalCodeDocId(path, startLine, endLine);
          touch(docId, { path, startLine, endLine, fusible: true, snippet: text }, "semantic");
          ranking.push({ docId, score: h.score });
        }
        rankings.push(ranking);
        sourcesUsed.push("semantic");
      } else if (hits === null) {
        notes.push("semantic index not built (cold) — bm25 only");
      }
    } catch {
      notes.push("semantic unavailable (no embedder) — bm25 only");
    }
  }

  // Graph expansion (only for identifier-like queries).
  if (opts.graph !== false && isSymbolLike(query)) {
    try {
      const chunkMap = buildChunkMap(meta);
      const result = await findReferences(root, {
        symbol: query.trim(),
        relation: "callers",
      });
      const sorted = [...result.records].sort((a, b) => b.score - a.score);
      const ranking: RankedHit[] = [];
      for (const rec of sorted.slice(0, perSource)) {
        const { docId, fusible } = relationRecordToChunkId(
          rec.file,
          rec.line,
          rec.symbol,
          chunkMap,
        );
        touch(
          docId,
          {
            path: rec.file,
            startLine: rec.line,
            endLine: rec.line,
            fusible,
            snippet: rec.snippet,
          },
          "graph",
        );
        ranking.push({ docId, score: rec.score });
      }
      if (ranking.length > 0) {
        rankings.push(ranking);
        sourcesUsed.push("graph");
      }
    } catch {
      notes.push("graph expansion failed — lexical/semantic only");
    }
  }

  const fused = fuseRrf(rankings);
  const hits: RetrievalHit[] = [];
  for (const f of fused.slice(0, topK)) {
    const m = meta.get(f.docId);
    if (!m) continue;
    hits.push({
      docId: f.docId,
      path: m.path,
      startLine: m.startLine,
      endLine: m.endLine,
      score: f.score,
      sources: [...m.sources],
      fusible: m.fusible,
      snippet: m.snippet,
    });
  }

  return { hits, sourcesUsed, notes };
}

function buildChunkMap(meta: Map<string, HitMeta>): ChunkMap {
  const map: ChunkMap = new Map();
  for (const [docId, m] of meta) {
    if (!m.fusible) continue;
    const range: ChunkRange = { start: m.startLine, end: m.endLine, docId };
    const list = map.get(m.path);
    if (list) list.push(range);
    else map.set(m.path, [range]);
  }
  return map;
}

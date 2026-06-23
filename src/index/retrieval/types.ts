// Pillar 5 unified retrieval types + canonical docId projection (FR-001/FR-008).
// The projection is what makes fuseRrf a real fusion rather than a concat:
// bm25/semantic/graph hits at the same code location must share one docId.

export type RetrievalSource = "bm25" | "semantic" | "graph";

export interface RetrievalHit {
  docId: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  sources: RetrievalSource[];
  fusible: boolean;
  snippet?: string | undefined;
}

export interface ParsedDocId {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ChunkRange {
  start: number;
  end: number;
  docId: string;
}

export type ChunkMap = Map<string, ChunkRange[]>;

// bm25 code chunks and semantic chunks share this id shape (same chunker, same
// window params) — that shared shape is the precondition for RRF to merge them.
export function canonicalCodeDocId(path: string, startLine: number, endLine: number): string {
  return `${path}:${startLine}-${endLine}`;
}

const DOC_ID_RE = /^(.*):(\d+)-(\d+)$/;

export function parseCanonicalDocId(docId: string): ParsedDocId | null {
  const m = DOC_ID_RE.exec(docId);
  if (!m) return null;
  const [, path, start, end] = m;
  if (path === undefined || start === undefined || end === undefined) return null;
  return { path, startLine: Number(start), endLine: Number(end) };
}

// Project a graph relation (file:line) onto the chunk that contains it so the
// hit fuses with bm25/semantic; fail-closed to a non-fusible synthetic id.
export function relationRecordToChunkId(
  file: string,
  line: number,
  symbol: string,
  chunkMap: ChunkMap,
): { docId: string; fusible: boolean } {
  const ranges = chunkMap.get(file);
  if (ranges) {
    const hit = ranges.find((r) => line >= r.start && line <= r.end);
    if (hit) return { docId: hit.docId, fusible: true };
  }
  return { docId: `graph:${file}:${line}:${symbol}`, fusible: false };
}

// A query worth a graph expansion looks like a single identifier, not prose.
const SYMBOL_RE = /^[A-Za-z_$][\w$.]*$/;

export function isSymbolLike(query: string): boolean {
  return SYMBOL_RE.test(query.trim());
}

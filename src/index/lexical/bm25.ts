import { emptyMap } from "../../utils/safe-object.js";

export interface Bm25Hit {
  docId: string;
  score: number;
}

export interface SerializedBm25Index {
  version: 1;
  k1: number;
  b: number;
  docs: Array<{
    id: string;
    length: number;
    terms: Record<string, number>;
  }>;
}

interface DocState {
  length: number;
  terms: Map<string, number>;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const SERIALIZED_VERSION = 1;

export class Bm25Index {
  private readonly docs = new Map<string, DocState>();
  private readonly documentFrequency = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = DEFAULT_K1,
    private readonly b = DEFAULT_B,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  get averageDocumentLength(): number {
    return this.docs.size === 0 ? 0 : this.totalLength / this.docs.size;
  }

  add(docId: string, tokens: readonly string[]): void {
    const normalized = normalizeTokens(tokens);
    this.remove(docId);
    if (normalized.length === 0) return;

    const terms = new Map<string, number>();
    for (const token of normalized) {
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }

    this.docs.set(docId, { length: normalized.length, terms });
    this.totalLength += normalized.length;
    for (const token of terms.keys()) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
    }
  }

  remove(docId: string): void {
    const existing = this.docs.get(docId);
    if (!existing) return;
    this.docs.delete(docId);
    this.totalLength -= existing.length;
    for (const token of existing.terms.keys()) {
      const next = (this.documentFrequency.get(token) ?? 0) - 1;
      if (next > 0) this.documentFrequency.set(token, next);
      else this.documentFrequency.delete(token);
    }
  }

  search(queryTokens: readonly string[], topK = 8): Bm25Hit[] {
    if (this.docs.size === 0 || topK <= 0) return [];
    const query = [...new Set(normalizeTokens(queryTokens))];
    if (query.length === 0) return [];

    const avgdl = this.averageDocumentLength || 1;
    const scores = new Map<string, number>();

    for (const token of query) {
      const df = this.documentFrequency.get(token);
      if (!df) continue;
      const idf = Math.log(1 + (this.docs.size - df + 0.5) / (df + 0.5));

      for (const [docId, doc] of this.docs) {
        const tf = doc.terms.get(token);
        if (!tf) continue;
        const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
        const score = idf * ((tf * (this.k1 + 1)) / denominator);
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, topK);
  }

  serialize(): string {
    const docs = [...this.docs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, doc]) => {
        const terms = emptyMap<number>();
        for (const [token, count] of [...doc.terms.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          terms[token] = count;
        }
        return { id, length: doc.length, terms };
      });
    return JSON.stringify({
      version: SERIALIZED_VERSION,
      k1: this.k1,
      b: this.b,
      docs,
    } satisfies SerializedBm25Index);
  }

  static load(buf: string): Bm25Index {
    const parsed = parseSerialized(buf);
    const index = new Bm25Index(parsed.k1, parsed.b);
    for (const doc of parsed.docs) {
      const tokens: string[] = [];
      for (const [token, count] of Object.entries(doc.terms)) {
        for (let i = 0; i < count; i++) tokens.push(token);
      }
      index.add(doc.id, tokens);
    }
    return index;
  }
}

function normalizeTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (token) out.push(token);
  }
  return out;
}

function parseSerialized(buf: string): SerializedBm25Index {
  const parsed: unknown = JSON.parse(buf);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid BM25 index");
  const value = parsed as Partial<SerializedBm25Index>;
  if (value.version !== SERIALIZED_VERSION) throw new Error("unsupported BM25 index version");
  if (typeof value.k1 !== "number" || typeof value.b !== "number") {
    throw new Error("invalid BM25 parameters");
  }
  if (!Array.isArray(value.docs)) throw new Error("invalid BM25 docs");

  const docs: SerializedBm25Index["docs"] = [];
  for (const rawDoc of value.docs) {
    if (!rawDoc || typeof rawDoc !== "object") throw new Error("invalid BM25 doc");
    const doc = rawDoc as Partial<SerializedBm25Index["docs"][number]>;
    if (typeof doc.id !== "string" || typeof doc.length !== "number") {
      throw new Error("invalid BM25 doc identity");
    }
    if (!doc.terms || typeof doc.terms !== "object" || Array.isArray(doc.terms)) {
      throw new Error("invalid BM25 term map");
    }
    const terms = emptyMap<number>();
    for (const [token, count] of Object.entries(doc.terms)) {
      if (typeof count !== "number" || count <= 0 || !Number.isFinite(count)) {
        throw new Error("invalid BM25 term frequency");
      }
      terms[token] = count;
    }
    docs.push({ id: doc.id, length: doc.length, terms });
  }

  return { version: SERIALIZED_VERSION, k1: value.k1, b: value.b, docs };
}

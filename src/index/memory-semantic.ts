import { promises as fs } from "node:fs";
import path from "node:path";
import { type EmbedOptions, embed, embedAll } from "./semantic/embedding.js";
import { normalize } from "./semantic/store.js";

export interface MemorySemanticEntry {
  docId: string;
  text: string;
  embedding: Float32Array;
}

export interface MemorySemanticHit {
  docId: string;
  text: string;
  score: number;
}

export interface MemorySemanticAddInput {
  docId: string;
  text: string;
  embedding?: Float32Array;
}

interface EmbeddedMemorySemanticInput extends Omit<MemorySemanticAddInput, "embedding"> {
  embedding: Float32Array;
}

export type EmbedText = (text: string) => Promise<Float32Array>;

const DATA_FILE = "embeddings.bin";

export class MemorySemanticStore {
  private entries: MemorySemanticEntry[] = [];
  private dim = 0;

  constructor(public readonly indexDir: string) {}

  get size(): number {
    return this.entries.length;
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  get all(): readonly MemorySemanticEntry[] {
    return this.entries;
  }

  async add(inputs: readonly MemorySemanticAddInput[], opts: { embedText?: EmbedText } = {}) {
    if (inputs.length === 0) return;
    const embedText = opts.embedText ?? ((text: string) => embed(text));
    const missing = inputs.filter((input) => !input.embedding);
    const generated =
      missing.length === 0
        ? []
        : await Promise.all(missing.map((input) => embedText(input.text).then(normalize)));
    const generatedByDoc = new Map<string, Float32Array>();
    for (let i = 0; i < missing.length; i++) {
      generatedByDoc.set(missing[i]!.docId, generated[i]!);
    }

    for (const input of inputs) {
      const embedding = normalize(input.embedding ?? generatedByDoc.get(input.docId)!);
      this.addEmbedded({ docId: input.docId, text: input.text, embedding });
    }
    await this.flush();
  }

  async rebuild(
    inputs: readonly Omit<MemorySemanticAddInput, "embedding">[],
    opts: EmbedOptions & { embedText?: EmbedText } = {},
  ): Promise<void> {
    try {
      const ready = await this.embedInputs(inputs, opts);
      this.entries = [];
      this.dim = 0;
      if (ready.length === 0) {
        await this.wipe();
        return;
      }
      for (const input of ready) {
        this.addEmbedded({
          docId: input.docId,
          text: input.text,
          embedding: normalize(input.embedding),
        });
      }
      await this.flush();
    } catch (err) {
      await this.wipe();
      throw err;
    }
  }

  search(query: Float32Array, topK = 8): MemorySemanticHit[] {
    if (this.entries.length === 0 || topK <= 0) return [];
    const normalized = normalize(query);
    const hits: MemorySemanticHit[] = [];
    for (const entry of this.entries) {
      hits.push({ docId: entry.docId, text: entry.text, score: dot(normalized, entry.embedding) });
    }
    return hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, topK);
  }

  async query(text: string, topK = 8, opts: { embedText?: EmbedText } = {}) {
    const embedText = opts.embedText ?? ((input: string) => embed(input));
    const vector = await embedText(text);
    return this.search(vector, topK);
  }

  async wipe(): Promise<void> {
    this.entries = [];
    this.dim = 0;
    await fs.rm(path.join(this.indexDir, DATA_FILE), { force: true });
  }

  private addEmbedded(entry: MemorySemanticEntry): void {
    if (this.dim === 0) this.dim = entry.embedding.length;
    if (entry.embedding.length !== this.dim) {
      throw new Error(
        `memory embedding dim mismatch: expected ${this.dim}, got ${entry.embedding.length} for ${entry.docId}`,
      );
    }
    const idx = this.entries.findIndex((existing) => existing.docId === entry.docId);
    if (idx >= 0) this.entries.splice(idx, 1);
    this.entries.push(entry);
  }

  private async flush(): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    const lines = this.entries
      .sort((a, b) => a.docId.localeCompare(b.docId))
      .map((entry) => {
        const buf = Buffer.from(
          entry.embedding.buffer,
          entry.embedding.byteOffset,
          entry.embedding.byteLength,
        );
        return JSON.stringify({
          id: entry.docId,
          text: entry.text,
          vector: buf.toString("base64"),
        });
      })
      .join("\n");
    const final = path.join(this.indexDir, DATA_FILE);
    const tmp = `${final}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, lines ? `${lines}\n` : "", "utf8");
    await fs.rename(tmp, final);
  }

  private async embedInputs(
    inputs: readonly Omit<MemorySemanticAddInput, "embedding">[],
    opts: EmbedOptions & { embedText?: EmbedText },
  ): Promise<EmbeddedMemorySemanticInput[]> {
    if (inputs.length === 0) return [];
    if (opts.embedText) {
      const vectors = await Promise.all(inputs.map((input) => opts.embedText!(input.text)));
      return inputs.map((input, i) => ({ ...input, embedding: vectors[i]! }));
    }
    const vectors = await embedAll(
      inputs.map((input) => input.text),
      opts,
    );
    const ready: EmbeddedMemorySemanticInput[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      ready.push({ ...inputs[i]!, embedding: vector });
    }
    return ready;
  }
}

export async function openMemorySemanticStore(indexDir: string): Promise<MemorySemanticStore> {
  const store = new MemorySemanticStore(indexDir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(indexDir, DATA_FILE), "utf8");
  } catch {
    return store;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = deserializeEntry(line);
    if (!entry) continue;
    (store as unknown as { addEmbedded(entry: MemorySemanticEntry): void }).addEmbedded(entry);
  }
  return store;
}

function deserializeEntry(line: string): MemorySemanticEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { id?: unknown; text?: unknown; vector?: unknown };
    if (typeof value.id !== "string" || typeof value.text !== "string") return null;
    if (typeof value.vector !== "string") return null;
    const buf = Buffer.from(value.vector, "base64");
    return {
      docId: value.id,
      text: value.text,
      embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    };
  } catch {
    return null;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i]! * b[i]!;
  return score;
}

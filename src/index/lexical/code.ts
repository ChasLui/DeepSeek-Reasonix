import { promises as fs } from "node:fs";
import path from "node:path";
import { segmentCjk } from "../cjk/segment.js";
import { type ResolvedIndexConfig, defaultIndexConfig } from "../config.js";
import { chunkDirectory } from "../semantic/chunker.js";
import type { CodeChunk } from "../semantic/chunker.js";
import { Bm25Index } from "./bm25.js";

export const CODE_LEXICAL_INDEX_FILE = path.join(".reasonix", "index", "lexical", "code.json");

export interface BuildCodeLexicalOptions {
  config?: ResolvedIndexConfig;
  windowLines?: number;
  overlap?: number;
}

// Build the code-text BM25 index WITHOUT an embedder — decoupled from the
// semantic build so it works with no ollama (Pillar 5 always-on layer).
export async function buildCodeLexicalIndex(
  root: string,
  opts: BuildCodeLexicalOptions = {},
): Promise<number> {
  const chunks = await chunkDirectory(root, {
    config: opts.config ?? defaultIndexConfig(),
    windowLines: opts.windowLines,
    overlap: opts.overlap,
  });
  return writeCodeLexicalIndex(root, chunks);
}

export async function writeCodeLexicalIndex(
  root: string,
  chunks: readonly CodeChunk[],
): Promise<number> {
  const index = new Bm25Index();
  for (const chunk of chunks) {
    index.add(codeChunkDocId(chunk), segmentCjk(`${chunk.path}\n${chunk.text}`));
  }

  const file = codeLexicalIndexPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, index.serialize(), "utf8");
  await fs.rename(tmp, file);
  return index.size;
}

export async function openCodeLexicalIndex(root: string): Promise<Bm25Index | null> {
  try {
    return Bm25Index.load(await fs.readFile(codeLexicalIndexPath(root), "utf8"));
  } catch {
    return null;
  }
}

const lexicalBuildCooldown = new Map<string, number>();

function lexicalBuildCooldownMs(): number {
  const raw = Number(process.env.REASONIX_LEXICAL_BUILD_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

// Lazy open-or-build with a per-root cooldown so a failing build can't livelock
// the caller (mirrors the code-graph build cooldown).
export async function openOrBuildCodeLexicalIndex(
  root: string,
  opts: BuildCodeLexicalOptions = {},
): Promise<Bm25Index | null> {
  const existing = await openCodeLexicalIndex(root);
  if (existing) return existing;
  const last = lexicalBuildCooldown.get(root);
  if (last !== undefined && Date.now() - last < lexicalBuildCooldownMs()) return null;
  try {
    await buildCodeLexicalIndex(root, opts);
  } catch {
    lexicalBuildCooldown.set(root, Date.now());
    return null;
  }
  return openCodeLexicalIndex(root);
}

export function codeLexicalIndexPath(root: string): string {
  return path.join(root, CODE_LEXICAL_INDEX_FILE);
}

function codeChunkDocId(chunk: CodeChunk): string {
  return `${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
}

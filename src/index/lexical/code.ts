import { promises as fs } from "node:fs";
import path from "node:path";
import { segmentCjk } from "../cjk/segment.js";
import type { CodeChunk } from "../semantic/chunker.js";
import { Bm25Index } from "./bm25.js";

export const CODE_LEXICAL_INDEX_FILE = path.join(".reasonix", "index", "lexical", "code.json");

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

export function codeLexicalIndexPath(root: string): string {
  return path.join(root, CODE_LEXICAL_INDEX_FILE);
}

function codeChunkDocId(chunk: CodeChunk): string {
  return `${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
}

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { segmentCjk } from "../src/index/cjk/segment.js";
import {
  buildCodeLexicalIndex,
  codeLexicalIndexPath,
  openCodeLexicalIndex,
  openOrBuildCodeLexicalIndex,
} from "../src/index/lexical/code.js";

const roots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-lexical-"));
  roots.push(root);
  writeFileSync(
    join(root, "auth.ts"),
    "export function validateToken(token: string) {\n  return token.length > 0;\n}\n",
  );
  writeFileSync(
    join(root, "cache.ts"),
    "export class PrefixCache {\n  hit(): boolean {\n    return true;\n  }\n}\n",
  );
  return root;
}

function topDocId(root: import("../src/index/lexical/bm25.js").Bm25Index, query: string): string {
  const hits = root.search(segmentCjk(query), 5);
  return hits[0]?.docId ?? "";
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("code lexical index — embedder-free round-trip (SC-007)", () => {
  it("builds without an embedder and writes the index file", async () => {
    const root = makeRepo();
    const size = await buildCodeLexicalIndex(root);
    expect(size).toBeGreaterThan(0);
    expect(existsSync(codeLexicalIndexPath(root))).toBe(true);
  });

  it("round-trips: build → open → BM25 search ranks the right file", async () => {
    const root = makeRepo();
    await buildCodeLexicalIndex(root);
    const index = await openCodeLexicalIndex(root);
    expect(index).not.toBeNull();
    if (!index) return;
    expect(topDocId(index, "validateToken")).toContain("auth.ts");
    expect(topDocId(index, "PrefixCache")).toContain("cache.ts");
  });

  it("openOrBuild lazily builds on a cold root (no ollama)", async () => {
    const root = makeRepo();
    expect(existsSync(codeLexicalIndexPath(root))).toBe(false);
    const index = await openOrBuildCodeLexicalIndex(root);
    expect(index).not.toBeNull();
    expect(existsSync(codeLexicalIndexPath(root))).toBe(true);
  });

  it("openOrBuild returns the existing index without rebuilding when present", async () => {
    const root = makeRepo();
    await buildCodeLexicalIndex(root);
    const index = await openOrBuildCodeLexicalIndex(root);
    expect(index).not.toBeNull();
    if (!index) return;
    expect(topDocId(index, "validateToken")).toContain("auth.ts");
  });
});

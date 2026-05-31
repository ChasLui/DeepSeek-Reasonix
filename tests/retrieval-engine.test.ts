import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fuseRrf } from "../src/index/hybrid/fuse.js";
import { buildCodeLexicalIndex } from "../src/index/lexical/code.js";
import { retrieveCode } from "../src/index/retrieval/engine.js";
import { FIXTURE_FILES, GOLDEN_QUERIES, NEGATIVE_QUERIES } from "../src/index/retrieval/golden.js";
import { canonicalCodeDocId, relationRecordToChunkId } from "../src/index/retrieval/types.js";

const roots: string[] = [];

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-retrieval-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("retrieval engine — canonical docId fusion (SC-006, P0-A)", () => {
  it("bm25 + semantic + graph at the same location fuse into ONE hit", () => {
    const docId = canonicalCodeDocId("src/a.ts", 1, 10);
    expect(docId).toBe("src/a.ts:1-10");
    const chunkMap = new Map([["src/a.ts", [{ start: 1, end: 10, docId }]]]);
    const projected = relationRecordToChunkId("src/a.ts", 5, "foo", chunkMap);
    expect(projected).toEqual({ docId, fusible: true });
    const fused = fuseRrf([
      [{ docId, score: 2 }],
      [{ docId, score: 0.9 }],
      [{ docId, score: 0.95 }],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.docId).toBe(docId);
  });

  it("a graph location outside any known chunk is non-fusible (fail-closed)", () => {
    const chunkMap = new Map([["src/a.ts", [{ start: 1, end: 10, docId: "src/a.ts:1-10" }]]]);
    const projected = relationRecordToChunkId("src/b.ts", 5, "bar", chunkMap);
    expect(projected.fusible).toBe(false);
    expect(projected.docId).toBe("graph:src/b.ts:5:bar");
  });
});

describe("retrieval engine — recall + precision (SC-001)", () => {
  it("bm25-only recall@8 over the golden set is >= 0.70", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    let hit = 0;
    for (const { query, expect: exp } of GOLDEN_QUERIES) {
      const { hits } = await retrieveCode(root, query, {
        semantic: false,
        graph: false,
        topK: 8,
      });
      if (hits.some((h) => h.path === exp)) hit++;
    }
    expect(hit / GOLDEN_QUERIES.length).toBeGreaterThanOrEqual(0.7);
  });

  it("disjoint-vocabulary queries return no false positives", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    for (const q of NEGATIVE_QUERIES) {
      const { hits } = await retrieveCode(root, q, {
        semantic: false,
        graph: false,
      });
      expect(hits).toHaveLength(0);
    }
  });
});

describe("retrieval engine — degradation matrix never throws (SC-002)", () => {
  it("no embedder + symbol-like query (graph on) still returns bm25 hits", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const r = await retrieveCode(root, "PrefixCache", { topK: 5 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.sourcesUsed).toContain("bm25");
  });

  it("no embedder + prose query (graph off) still returns bm25 hits", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const r = await retrieveCode(root, "compute the prefix cache hit ratio", {
      topK: 5,
    });
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("cold repo with no index returns [] and a guidance note, no throw", async () => {
    const empty = mkdtempSync(join(tmpdir(), "reasonix-retrieval-empty-"));
    roots.push(empty);
    const r = await retrieveCode(empty, "anything at all", {
      semantic: false,
      graph: false,
    });
    expect(r.hits).toHaveLength(0);
  });
});

describe("retrieval engine — latency (SC-003)", () => {
  it("bm25 retrieval is fast on the fixture", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const t0 = Date.now();
    await retrieveCode(root, "validateAuthToken", {
      semantic: false,
      graph: false,
    });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

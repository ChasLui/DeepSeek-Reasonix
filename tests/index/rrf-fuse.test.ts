import { describe, expect, it } from "vitest";
import { fuseRrf } from "../../src/index/hybrid/fuse.js";

describe("fuseRrf", () => {
  it("returns an empty list for empty rankings", () => {
    expect(fuseRrf([])).toEqual([]);
  });

  it("keeps a single ranking in rank order", () => {
    expect(
      fuseRrf([
        [
          { docId: "a", score: 10 },
          { docId: "b", score: 8 },
        ],
      ]).map((hit) => hit.docId),
    ).toEqual(["a", "b"]);
  });

  it("boosts documents that appear in multiple rankings", () => {
    const fused = fuseRrf([
      [
        { docId: "a", score: 10 },
        { docId: "shared", score: 2 },
      ],
      [
        { docId: "b", score: 9 },
        { docId: "shared", score: 1 },
      ],
    ]);
    expect(fused[0]?.docId).toBe("shared");
  });

  it("keeps vector-only and BM25-only top hits in the fused window", () => {
    const fused = fuseRrf([
      [
        { docId: "vector_top", score: 0.9 },
        { docId: "shared", score: 0.8 },
      ],
      [
        { docId: "bm25_top", score: 12 },
        { docId: "shared", score: 11 },
      ],
    ]);
    const topK = fused.slice(0, 8).map((hit) => hit.docId);
    expect(topK).toContain("vector_top");
    expect(topK).toContain("bm25_top");
  });

  it("deduplicates repeated ids inside one ranking", () => {
    const fused = fuseRrf([
      [
        { docId: "a", score: 10 },
        { docId: "a", score: 9 },
      ],
    ]);
    expect(fused).toHaveLength(1);
  });

  it("uses first-seen order as a deterministic tie-breaker", () => {
    const fused = fuseRrf([
      [
        { docId: "a", score: 1 },
        { docId: "b", score: 1 },
      ],
      [
        { docId: "b", score: 1 },
        { docId: "a", score: 1 },
      ],
    ]);
    expect(fused.map((hit) => hit.docId)).toEqual(["a", "b"]);
  });
});

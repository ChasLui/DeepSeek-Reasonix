import { describe, expect, it } from "vitest";
import { segmentCjk } from "../../src/index/cjk/segment.js";
import { Bm25Index } from "../../src/index/lexical/bm25.js";

describe("Bm25Index", () => {
  it("returns an empty list for an empty index", () => {
    const index = new Bm25Index();
    expect(index.search(["cache"])).toEqual([]);
  });

  it("ranks documents containing the query token", () => {
    const index = new Bm25Index();
    index.add("a", ["prompt", "cache", "cache"]);
    index.add("b", ["prompt", "repair"]);
    expect(index.search(["cache"]).map((hit) => hit.docId)).toEqual(["a"]);
  });

  it("deduplicates query tokens", () => {
    const index = new Bm25Index();
    index.add("a", ["cache"]);
    const once = index.search(["cache"])[0]?.score;
    const repeated = index.search(["cache", "cache", "cache"])[0]?.score;
    expect(repeated).toBe(once);
  });

  it("removes stale documents when re-adding the same id", () => {
    const index = new Bm25Index();
    index.add("a", ["old"]);
    index.add("a", ["new"]);
    expect(index.search(["old"])).toEqual([]);
    expect(index.search(["new"]).map((hit) => hit.docId)).toEqual(["a"]);
  });

  it("removes a document and its document frequency", () => {
    const index = new Bm25Index();
    index.add("a", ["cache"]);
    index.add("b", ["cache"]);
    index.remove("a");
    expect(index.search(["cache"]).map((hit) => hit.docId)).toEqual(["b"]);
  });

  it("honors topK", () => {
    const index = new Bm25Index();
    index.add("a", ["cache", "cache", "cache"]);
    index.add("b", ["cache", "cache"]);
    index.add("c", ["cache"]);
    expect(index.search(["cache"], 2)).toHaveLength(2);
  });

  it("normalizes token case and whitespace", () => {
    const index = new Bm25Index();
    index.add("a", [" Cache "]);
    expect(index.search(["cache"]).map((hit) => hit.docId)).toEqual(["a"]);
  });

  it("round-trips through serialize/load", () => {
    const index = new Bm25Index();
    index.add("a", ["prompt", "cache"]);
    index.add("b", ["tool", "repair"]);
    const loaded = Bm25Index.load(index.serialize());
    expect(loaded.search(["prompt"]).map((hit) => hit.docId)).toEqual(["a"]);
    expect(loaded.size).toBe(2);
  });

  it("rejects unsupported serialized versions", () => {
    expect(() =>
      Bm25Index.load(JSON.stringify({ version: 99, k1: 1.2, b: 0.75, docs: [] })),
    ).toThrow(/unsupported/);
  });

  it("recalls CJK entries through bigram tokens", () => {
    const index = new Bm25Index();
    const docs = [
      ["a", "缓存优先策略要求 append-only log，不要重排早期 turn"],
      ["b", "prompt cache 漂移时先检查 prefix fingerprint"],
      ["c", "工具修复 pipeline 包含 flatten scavenge truncation storm"],
      ["d", "中文搜索需要双字分词才能匹配长词"],
      ["e", "缓存优先策略和成本控制是 Reasonix 的核心"],
    ] as const;
    for (const [id, text] of docs) index.add(id, segmentCjk(text, { loadJieba: () => null }));

    const hits = index.search(segmentCjk("缓存优先策略", { loadJieba: () => null }), 3);

    expect(hits.filter((hit) => hit.docId === "a" || hit.docId === "e")).toHaveLength(2);
  });
});

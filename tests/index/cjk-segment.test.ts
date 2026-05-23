import { afterEach, describe, expect, it, vi } from "vitest";
import { detectScript, hasCjk, segmentCjk } from "../../src/index/cjk/segment.js";

describe("CJK segmenter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects CJK text", () => {
    expect(hasCjk("缓存优先")).toBe(true);
    expect(hasCjk("prompt cache")).toBe(false);
  });

  it("classifies scripts", () => {
    expect(detectScript("prompt cache")).toBe("latin");
    expect(detectScript("缓存优先")).toBe("cjk");
    expect(detectScript("prompt 缓存")).toBe("mixed");
    expect(detectScript("!!!")).toBe("other");
  });

  it("uses a loaded jieba-compatible cutter when available", () => {
    const tokens = segmentCjk("缓存优先策略", {
      loadJieba: () => ({ cut: () => ["缓存", "优先", "策略"] }),
    });
    expect(tokens).toEqual(["缓存", "优先", "策略"]);
  });

  it("falls back to CJK bigrams when the package loader throws", () => {
    const tokens = segmentCjk("缓存优先", {
      loadJieba: () => {
        throw new Error("load failed");
      },
    });
    expect(tokens).toEqual(["缓存", "存优", "优先"]);
  });

  it("falls back to CJK bigrams when construction throws", () => {
    class BrokenJieba {
      constructor() {
        throw new Error("native init failed");
      }
    }
    const tokens = segmentCjk("缓存优先", {
      loadJieba: () => ({ Jieba: BrokenJieba }),
    });
    expect(tokens).toEqual(["缓存", "存优", "优先"]);
  });

  it("honors REASONIX_CJK_JIEBA=0 before loading jieba", () => {
    vi.stubEnv("REASONIX_CJK_JIEBA", "0");
    const loadJieba = vi.fn(() => ({ cut: () => ["SHOULD_NOT_LOAD"] }));
    const tokens = segmentCjk("缓存优先", { loadJieba });
    expect(tokens).toEqual(["缓存", "存优", "优先"]);
    expect(loadJieba).not.toHaveBeenCalled();
  });

  it("keeps latin tokens in mixed text", () => {
    expect(segmentCjk("prompt cache 漂移", { loadJieba: () => null })).toEqual([
      "prompt",
      "cache",
      "漂移",
    ]);
  });

  it("segments Japanese kana with the same fallback path", () => {
    expect(segmentCjk("かなカナ", { loadJieba: () => null })).toEqual(["かな", "なカ", "カナ"]);
  });

  it("segments Korean Hangul with the same fallback path", () => {
    expect(segmentCjk("한글검색", { loadJieba: () => null })).toEqual(["한글", "글검", "검색"]);
  });

  it("drops punctuation-only tokens from jieba output", () => {
    const tokens = segmentCjk("缓存，优先", {
      loadJieba: () => ({ cut: () => ["缓存", "，", "优先"] }),
    });
    expect(tokens).toEqual(["缓存", "优先"]);
  });
});

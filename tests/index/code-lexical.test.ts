import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codeLexicalIndexPath,
  openCodeLexicalIndex,
  writeCodeLexicalIndex,
} from "../../src/index/lexical/code.js";

describe("code lexical index", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reasonix-code-lexical-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists BM25 docs under .reasonix/index/lexical/code.json", async () => {
    const previous = process.env.REASONIX_CJK_JIEBA;
    process.env.REASONIX_CJK_JIEBA = "0";
    try {
      const count = await writeCodeLexicalIndex(root, [
        {
          path: "src/cache.ts",
          startLine: 1,
          endLine: 3,
          text: "export const prefixCache = 'cache first';",
        },
        {
          path: "src/notes.ts",
          startLine: 4,
          endLine: 8,
          text: "中文缓存优先策略",
        },
      ]);

      expect(count).toBe(2);
      expect(codeLexicalIndexPath(root)).toBe(
        join(root, ".reasonix", "index", "lexical", "code.json"),
      );

      const index = await openCodeLexicalIndex(root);
      expect(index?.size).toBe(2);
      expect(index?.search(["prefixcache"], 1)[0]?.docId).toBe("src/cache.ts:1-3");
      expect(index?.search(["缓存"], 1)[0]?.docId).toBe("src/notes.ts:4-8");
    } finally {
      if (previous === undefined) process.env.REASONIX_CJK_JIEBA = undefined;
      else process.env.REASONIX_CJK_JIEBA = previous;
    }
  });

  it("returns null when no code lexical index exists", async () => {
    await expect(openCodeLexicalIndex(root)).resolves.toBeNull();
  });
});

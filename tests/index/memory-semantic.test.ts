import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySemanticStore, openMemorySemanticStore } from "../../src/index/memory-semantic.js";

describe("MemorySemanticStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-memory-semantic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores memory embeddings separately from the code semantic path", async () => {
    const store = new MemorySemanticStore(join(dir, "memory", ".semantic"));
    await store.add([
      {
        docId: "global/cache_rule",
        text: "Cache rule\nKeep prefix append-only.",
        embedding: new Float32Array([1, 0]),
      },
    ]);

    expect(store.indexDir).toContain("memory/.semantic");
    expect(store.indexDir).not.toContain(".reasonix/semantic");
  });

  it("round-trips persisted embeddings", async () => {
    const store = new MemorySemanticStore(dir);
    await store.add([
      { docId: "global/a", text: "alpha", embedding: new Float32Array([1, 0]) },
      { docId: "global/b", text: "beta", embedding: new Float32Array([0, 1]) },
    ]);

    const loaded = await openMemorySemanticStore(dir);

    expect(loaded.size).toBe(2);
    expect(loaded.search(new Float32Array([1, 0]), 1)[0]?.docId).toBe("global/a");
  });

  it("can embed missing vectors through an injected embedder", async () => {
    const store = new MemorySemanticStore(dir);
    await store.add([{ docId: "global/a", text: "alpha" }], {
      embedText: async () => new Float32Array([1, 0]),
    });

    expect(store.search(new Float32Array([1, 0]), 1)[0]?.docId).toBe("global/a");
  });

  it("replaces an existing doc id", async () => {
    const store = new MemorySemanticStore(dir);
    await store.add([{ docId: "global/a", text: "alpha", embedding: new Float32Array([1, 0]) }]);
    await store.add([{ docId: "global/a", text: "beta", embedding: new Float32Array([0, 1]) }]);

    expect(store.size).toBe(1);
    expect(store.search(new Float32Array([0, 1]), 1)[0]?.text).toBe("beta");
  });

  it("removes stale persisted embeddings when rebuild embedding fails", async () => {
    const store = new MemorySemanticStore(dir);
    await store.rebuild([{ docId: "global/old", text: "old" }], {
      embedText: async () => new Float32Array([1, 0]),
    });
    expect((await openMemorySemanticStore(dir)).all.map((entry) => entry.docId)).toEqual([
      "global/old",
    ]);

    await expect(
      store.rebuild([{ docId: "global/new", text: "new" }], {
        embedText: async () => {
          throw new Error("embed down");
        },
      }),
    ).rejects.toThrow(/embed down/);

    expect((await openMemorySemanticStore(dir)).size).toBe(0);
  });

  it("clears persisted embeddings when rebuilding an empty input set", async () => {
    const store = new MemorySemanticStore(dir);
    await store.rebuild([{ docId: "global/old", text: "old" }], {
      embedText: async () => new Float32Array([1, 0]),
    });

    await store.rebuild([], { embedText: async () => new Float32Array([1, 0]) });

    expect((await openMemorySemanticStore(dir)).size).toBe(0);
  });
});

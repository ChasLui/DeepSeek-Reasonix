import { describe, expect, it } from "vitest";
import { createLruMemo, createTtlMemo, createTtlMemoAsync } from "../../src/utils/cache.js";

describe("cache memo helpers", () => {
  it("returns cached values and evicts least-recently-used entries", () => {
    const evicted: string[] = [];
    const memo = createLruMemo<string, { value: number }>({
      maxEntries: 2,
      onEvict: (key) => evicted.push(key),
    });
    let calls = 0;

    expect(memo.get("a", () => ({ value: ++calls })).value).toBe(1);
    expect(memo.get("a", () => ({ value: ++calls })).value).toBe(1);
    expect(memo.get("b", () => ({ value: ++calls })).value).toBe(2);
    expect(memo.get("c", () => ({ value: ++calls })).value).toBe(3);

    expect(memo.peek("a")).toBeUndefined();
    expect(evicted).toContain("a");
    expect(memo.stats()).toMatchObject({ hits: 1, misses: 3, evictions: 1, entries: 2 });
  });

  it("expires TTL entries", async () => {
    const memo = createTtlMemo<string, { value: number }>({ ttlMs: 5, maxEntries: 10 });
    let calls = 0;

    expect(memo.get("k", () => ({ value: ++calls })).value).toBe(1);
    await delay(10);
    expect(memo.get("k", () => ({ value: ++calls })).value).toBe(2);
    expect(memo.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("returns stale async values while one refresh runs", async () => {
    const memo = createTtlMemoAsync<string, { value: string }>({ ttlMs: 5, maxEntries: 10 });
    let next = "first";

    await expect(memo.get("k", async () => ({ value: next }))).resolves.toEqual({
      value: "first",
    });
    await delay(10);
    next = "second";
    await expect(memo.get("k", async () => ({ value: next }))).resolves.toEqual({
      value: "first",
    });
    await delay(0);
    await expect(memo.get("k", async () => ({ value: "third" }))).resolves.toEqual({
      value: "second",
    });
    expect(memo.stats()).toMatchObject({ hits: 2, misses: 1 });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

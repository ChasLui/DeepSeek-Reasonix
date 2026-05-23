import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../../src/client.js";
import { parseSource } from "../../src/code-query/parser.js";
import { CacheFirstLoop } from "../../src/loop.js";
import { ImmutablePrefix } from "../../src/memory/runtime.js";

describe("CacheFirstLoop cache ownership", () => {
  it("invalidates loop-owned file, parse, and web-fetch caches on log compaction", async () => {
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: vi.fn() as unknown as typeof fetch }),
      prefix: new ImmutablePrefix({ system: "test" }),
    });
    loop.fileCache.set("/tmp/a.ts", { mtimeMs: 1, size: 5 }, Buffer.from("alpha"), "sha", "utf8");
    loop.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      title: "A",
      text: "alpha",
      truncated: false,
    });
    const parsed = await parseSource("/tmp/a.ts", "function alpha() {}\n");
    loop.parseCache.set(
      { absPath: "/tmp/a.ts", mtimeMs: 1, size: 20, shaPrefix: "old" },
      parsed!.tree,
    );
    parsed!.tree.delete();

    expect(loop.fileCache.stats().entries).toBe(1);
    expect(loop.parseCache.stats().entries).toBe(1);
    expect(loop.webFetchCache.stats().entries).toBe(1);
    loop.log.compactInPlace([]);

    expect(loop.fileCache.stats().entries).toBe(0);
    expect(loop.parseCache.stats().entries).toBe(0);
    expect(loop.webFetchCache.stats().entries).toBe(0);
  });

  it("keeps cache instances isolated across loops", () => {
    const a = makeLoop();
    const b = makeLoop();
    const stat = { mtimeMs: 1, size: 5 };

    a.fileCache.set("/tmp/a.ts", stat, Buffer.from("alpha"), "a", "utf8");
    b.fileCache.set("/tmp/a.ts", stat, Buffer.from("bravo"), "b", "utf8");
    a.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      text: "alpha",
      truncated: false,
    });
    b.webFetchCache.set("https://example.com/a", 100, {
      url: "https://example.com/a",
      text: "bravo",
      truncated: false,
    });

    expect(a.fileCache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("alpha");
    expect(b.fileCache.get("/tmp/a.ts", stat)?.raw.toString("utf8")).toBe("bravo");
    expect(a.webFetchCache.get("https://example.com/a", 100)?.text).toBe("alpha");
    expect(b.webFetchCache.get("https://example.com/a", 100)?.text).toBe("bravo");
  });
});

function makeLoop(): CacheFirstLoop {
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test", fetch: vi.fn() as unknown as typeof fetch }),
    prefix: new ImmutablePrefix({ system: "test" }),
  });
}

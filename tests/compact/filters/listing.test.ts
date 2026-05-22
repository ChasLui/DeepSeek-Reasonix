import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listingCompactors } from "../../../src/compact/filters/listing.js";
import {
  applyCompactor,
  registerCompactor,
  resetCompactors,
} from "../../../src/compact/registry.js";

beforeEach(() => {
  resetCompactors();
  for (const c of listingCompactors) registerCompactor(c);
});
afterEach(() => {
  resetCompactors();
});

describe("ls filter", () => {
  it("abstains on short lists", () => {
    const out = ["foo.ts", "bar.ts", "baz.md"].join("\n");
    const r = applyCompactor("ls", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("passthrough");
  });

  it("groups by extension when over threshold", () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      i < 30 ? `file${i}.ts` : i < 50 ? `file${i}.md` : `subdir${i}/`,
    );
    const out = entries.join("\n");
    const r = applyCompactor("ls", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("ls");
    expect(r.compact).toContain(".ts: 30");
    expect(r.compact).toContain(".md: 20");
    expect(r.compact).toContain("dirs (10)");
  });

  it("recognizes ls -l form via 'total N' header", () => {
    const lines = ["total 80"];
    for (let i = 0; i < 60; i++) {
      lines.push(`-rw-r--r-- 1 me me 123 Jan 01 00:00 file${i}.ts`);
    }
    const out = lines.join("\n");
    const r = applyCompactor("ls -la", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("ls");
    expect(r.compact).toMatch(/60 entries/);
    expect(r.compact).toContain(".ts: 60");
  });
});

describe("tree filter", () => {
  it("shows hierarchical truncation", () => {
    const lines = ["root/"];
    for (let i = 0; i < 60; i++) lines.push(`├── child${i}`);
    const r = applyCompactor("tree", lines.join("\n"), {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("tree");
    expect(r.compact).toMatch(/showing first/);
    expect(r.compact).toContain("[… ");
  });
});

describe("find filter", () => {
  it("groups long path lists by extension", () => {
    const out = Array.from(
      { length: 80 },
      (_, i) => `./src/file${i}.${i % 2 === 0 ? "ts" : "py"}`,
    ).join("\n");
    const r = applyCompactor("find . -type f", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("find");
    expect(r.compact).toMatch(/80 paths/);
  });
});

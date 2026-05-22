import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linterCompactors } from "../../../src/compact/filters/linter.js";
import {
  applyCompactor,
  registerCompactor,
  resetCompactors,
} from "../../../src/compact/registry.js";

beforeEach(() => {
  resetCompactors();
  for (const c of linterCompactors) registerCompactor(c);
});
afterEach(() => {
  resetCompactors();
});

describe("eslint filter", () => {
  it("groups by file with rule counts", () => {
    const out = [
      "/repo/src/a.ts",
      "  12:5  error  Foo  no-unused-vars",
      "  13:5  error  Bar  no-unused-vars",
      "  14:5  error  Baz  semi",
      "",
      "/repo/src/b.ts",
      "  3:1  error  X  prefer-const",
      "",
      "✖ 4 problems",
    ].join("\n");
    const r = applyCompactor("npx eslint .", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("eslint");
    expect(r.compact).toMatch(/4 issues across 2 files/);
    expect(r.compact).toContain("a.ts: 3");
    expect(r.compact).toContain("no-unused-vars ×2");
    expect(r.compact).toContain("b.ts: 1");
  });

  it("abstains when no diagnostics", () => {
    const r = applyCompactor("npx eslint .", "", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });
});

describe("biome filter", () => {
  it("groups by file", () => {
    const out = [
      "src/foo.ts:12:5 lint/suspicious/noExplicitAny ━━",
      "  some explanation",
      "src/foo.ts:20:1 lint/correctness/noUnused ━━",
      "src/bar.ts:5:5 lint/style/useConst ━━",
    ].join("\n");
    const r = applyCompactor("npx biome check src", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("biome");
    expect(r.compact).toMatch(/3 issues across 2 files/);
    expect(r.compact).toContain("foo.ts: 2");
    expect(r.compact).toContain("bar.ts: 1");
  });
});

describe("tsc filter", () => {
  it("groups by file with TS codes", () => {
    const out = [
      "src/a.ts(5,10): error TS2304: Cannot find name 'Foo'.",
      "src/a.ts(6,1): error TS2304: Cannot find name 'Bar'.",
      "src/b.ts(1,1): error TS6133: 'x' is declared but its value is never read.",
      "Found 3 errors in 2 files.",
    ].join("\n");
    const r = applyCompactor("npx tsc --noEmit", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("tsc");
    expect(r.compact).toMatch(/3 issues across 2 files/);
    expect(r.compact).toContain("a.ts: 2");
    expect(r.compact).toContain("TS2304 ×2");
  });

  it("ok summary on zero errors", () => {
    const r = applyCompactor("npx tsc --noEmit", "Found 0 errors.", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("tsc");
    expect(r.compact).toMatch(/tsc — /);
  });

  it("abstains on unrecognized output", () => {
    const r = applyCompactor("npx tsc --noEmit", "weird junk", {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });
});

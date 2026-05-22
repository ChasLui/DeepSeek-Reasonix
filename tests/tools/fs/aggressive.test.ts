import { describe, expect, it } from "vitest";
import { applyAggressive, isAggressiveSupported } from "../../../src/tools/fs/aggressive.js";

describe("isAggressiveSupported", () => {
  it("accepts source languages", () => {
    for (const ext of [".ts", ".tsx", ".js", ".py", ".go", ".rs"]) {
      expect(isAggressiveSupported(`foo${ext}`)).toBe(true);
    }
  });
  it("rejects markdown and other formats", () => {
    expect(isAggressiveSupported("foo.md")).toBe(false);
    expect(isAggressiveSupported("foo.json")).toBe(false);
    expect(isAggressiveSupported("foo")).toBe(false);
  });
});

describe("applyAggressive TS", () => {
  it("collapses function body", () => {
    const src = [
      "export function foo(x: number): number {",
      "  // computes y",
      "  const y = x * 2;",
      "  return y;",
      "}",
    ].join("\n");
    const out = applyAggressive(src, "x.ts");
    expect(out).toContain("export function foo(x: number): number");
    expect(out).toContain("{ … }");
    expect(out).not.toContain("const y = x * 2");
    expect(out).not.toContain("// computes y");
  });

  it("strips block comments without shifting line numbers", () => {
    const src = ["/* multi", " * line", " */", "export const x = 1;"].join("\n");
    const out = applyAggressive(src, "x.ts");
    // The comment region keeps its newlines, so x = 1 still lands on line 4
    const lines = out.split("\n");
    expect(lines[3]).toContain("export const x = 1");
  });

  it("preserves interface declarations (declaration-only)", () => {
    const src = ["interface Foo {", "  a: number;", "  b: string;", "}"].join("\n");
    const out = applyAggressive(src, "x.ts");
    // Interfaces collapse to a one-line `{ … }` (same rule as functions).
    expect(out).toContain("interface Foo");
    expect(out).toContain("{ … }");
  });
});

describe("applyAggressive Python", () => {
  it("collapses def body to `: ...`", () => {
    const src = [
      "def add(a, b):",
      "    '''doc'''",
      "    c = a + b",
      "    return c",
      "",
      "class X:",
      "    def m(self):",
      "        return 1",
    ].join("\n");
    const out = applyAggressive(src, "x.py");
    expect(out).toContain("def add(a, b): ...");
    expect(out).toContain("class X: ...");
    expect(out).not.toContain("c = a + b");
  });

  it("strips `# …` comments", () => {
    const src = ["x = 1  # a comment", "y = 2"].join("\n");
    const out = applyAggressive(src, "x.py");
    expect(out).not.toContain("# a comment");
    expect(out).toContain("x = 1");
    expect(out).toContain("y = 2");
  });
});

describe("applyAggressive Go / Rust", () => {
  it("collapses Go func body", () => {
    const src = ["func Foo(x int) int {", "  return x * 2", "}"].join("\n");
    const out = applyAggressive(src, "x.go");
    expect(out).toContain("func Foo");
    expect(out).toContain("{ … }");
    expect(out).not.toContain("return x * 2");
  });

  it("collapses Rust fn body", () => {
    const src = ["pub fn foo(x: i32) -> i32 {", "    x * 2", "}"].join("\n");
    const out = applyAggressive(src, "x.rs");
    expect(out).toContain("pub fn foo");
    expect(out).toContain("{ … }");
    expect(out).not.toContain("x * 2");
  });
});

describe("unsupported extensions", () => {
  it("passes through markdown unchanged", () => {
    const src = "# Hello\n\nSome text.";
    expect(applyAggressive(src, "x.md")).toBe(src);
  });
});

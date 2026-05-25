import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import { ParseTreeCache } from "../../src/code-query/parser.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerCodeQueryTools } from "../../src/tools/code-query.js";
import { parseToolResult } from "../helpers/tool-result.js";

describe("code-query parse cache", () => {
  let root: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "reasonix-parse-cache-"));
    registry = new ToolRegistry();
    registerCodeQueryTools(registry, { rootDir: root });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reuses one parsed tree across get_symbols and find_in_code", async () => {
    await fs.writeFile(join(root, "a.ts"), "export function foo() { return 1; }\nfoo();\n");
    const parseCache = new ParseTreeCache();
    const parseSpy = vi.spyOn(Parser.prototype, "parse");

    const symbolsRaw = await registry.dispatch("get_symbols", { path: "a.ts" }, { parseCache });
    const symbols = parseToolResult<{ symbols: Array<{ name: string }> }>(symbolsRaw);
    const matchesRaw = await registry.dispatch(
      "find_in_code",
      { path: "a.ts", name: "foo" },
      { parseCache },
    );
    const matches = parseToolResult<{ matches: Array<{ line: number }> }>(matchesRaw);

    expect(symbols.symbols.map((s) => s.name)).toEqual(["foo"]);
    expect(matches.matches).toHaveLength(2);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseCache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it("misses when the file identity changes", async () => {
    const parseCache = new ParseTreeCache();
    await fs.writeFile(join(root, "a.ts"), "function foo() {}\n");
    await registry.dispatch("get_symbols", { path: "a.ts" }, { parseCache });

    await fs.writeFile(join(root, "a.ts"), "function foo() {}\nfunction bar() {}\n");
    await registry.dispatch("get_symbols", { path: "a.ts" }, { parseCache });

    expect(parseCache.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("lets find_references share parse results within one snapshot", async () => {
    vi.stubEnv("REASONIX_CODE_GRAPH", "0");
    await fs.writeFile(join(root, "a.ts"), "function foo() {}\nfunction caller() { foo(); }\n");
    const parseCache = new ParseTreeCache();

    await registry.dispatch(
      "find_references",
      { symbol: "foo", relation: "callers", scope: "a.ts" },
      { parseCache },
    );

    expect(parseCache.stats().hits).toBeGreaterThanOrEqual(1);
    expect(parseCache.stats().misses).toBe(1);
  });

  it("short-circuits off when REASONIX_PARSE_CACHE=0", async () => {
    vi.stubEnv("REASONIX_PARSE_CACHE", "0");
    await fs.writeFile(join(root, "a.ts"), "function foo() {}\nfoo();\n");
    const parseCache = new ParseTreeCache();

    await registry.dispatch("get_symbols", { path: "a.ts" }, { parseCache });
    await registry.dispatch("find_in_code", { path: "a.ts", name: "foo" }, { parseCache });

    expect(parseCache.stats()).toEqual({ hits: 0, misses: 0, evictions: 0, entries: 0 });
  });
});

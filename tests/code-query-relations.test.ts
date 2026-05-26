import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findReferences } from "../src/code-query/relations.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { scavengeToolCalls } from "../src/repair/scavenge.js";
import { countTokensBounded } from "../src/tokenizer.js";
import { ToolRegistry } from "../src/tools.js";
import { registerCodeQueryTools } from "../src/tools/code-query.js";
import { parseToolResult } from "./helpers/tool-result.js";

function writeProjectFile(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function initGitRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Reasonix Test"]);
}

describe("code relation tools", () => {
  let tmp: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-code-rel-"));
    registry = new ToolRegistry();
    registerCodeQueryTools(registry, { rootDir: tmp });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("registers the relation tools unless the code relation layer is disabled", () => {
    const names = registry.specs().map((spec) => spec.function.name);
    expect(names).toContain("find_references");
    expect(names).toContain("detect_changes");
    expect(names).toContain("impact");
    expect(registry.isParallelSafe("find_references")).toBe(false);
    const originalCodeGraph = process.env.REASONIX_CODE_GRAPH;
    process.env.REASONIX_CODE_GRAPH = "1";
    try {
      expect(registry.get("find_references")?.readOnlyCheck?.({ relation: "callers" })).toBe(false);
      expect(registry.get("find_references")?.readOnlyCheck?.({ relation: "imports" })).toBe(false);
      expect(registry.get("detect_changes")?.readOnlyCheck?.({ includeCallers: true })).toBe(false);
      expect(registry.get("detect_changes")?.readOnlyCheck?.({ includeCallers: false })).toBe(true);
      expect(registry.get("impact")?.readOnlyCheck?.({})).toBe(false);
    } finally {
      if (originalCodeGraph === undefined) {
        // biome-ignore lint/performance/noDelete: restore exact env state
        delete process.env.REASONIX_CODE_GRAPH;
      } else {
        process.env.REASONIX_CODE_GRAPH = originalCodeGraph;
      }
    }

    const disabled = new ToolRegistry();
    registerCodeQueryTools(disabled, { rootDir: tmp, codeRelationsEnabled: false });
    expect(disabled.has("get_symbols")).toBe(true);
    expect(disabled.has("find_references")).toBe(false);
    expect(disabled.has("detect_changes")).toBe(false);
    expect(disabled.has("impact")).toBe(false);

    registerCodeQueryTools(registry, { rootDir: tmp, codeRelationsEnabled: false });
    expect(registry.has("find_references")).toBe(false);
    expect(registry.has("detect_changes")).toBe(false);
    expect(registry.has("impact")).toBe(false);
  });

  it("find_references returns callers, callees, imports, importers, and confidence tiers", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      [
        "export function helper() { return 1; }",
        "export function local() { return helper(); }",
      ].join("\n"),
    );
    writeProjectFile(
      tmp,
      "src/b.ts",
      ['import { helper } from "./a";', "export function run() { return helper(); }"].join("\n"),
    );
    writeProjectFile(tmp, "src/c.ts", "export function loose() { return helper(); }\n");

    const callersRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "helper", relation: "callers", scope: "src" }),
    );
    const callers = parseToolResult<{
      records: Array<{ file: string; from?: { name: string }; confidence: string }>;
    }>(callersRaw);
    expect(callers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "src/a.ts",
          from: expect.objectContaining({ name: "local" }),
          confidence: "EXTRACTED",
        }),
        expect.objectContaining({
          file: "src/b.ts",
          from: expect.objectContaining({ name: "run" }),
          confidence: "INFERRED",
        }),
        expect.objectContaining({
          file: "src/c.ts",
          from: expect.objectContaining({ name: "loose" }),
          confidence: "AMBIGUOUS",
        }),
      ]),
    );

    const calleesRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "run", relation: "callees", scope: "src" }),
    );
    const callees = parseToolResult<{ records: Array<{ symbol: string; confidence: string }> }>(
      calleesRaw,
    );
    expect(callees.records).toContainEqual(
      expect.objectContaining({ symbol: "helper", confidence: "INFERRED" }),
    );

    const importsRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "run", relation: "imports", scope: "src" }),
    );
    const imports = parseToolResult<{ records: Array<{ module?: string; names?: string[] }> }>(
      importsRaw,
    );
    expect(imports.records).toContainEqual(
      expect.objectContaining({ module: "./a", names: expect.arrayContaining(["helper"]) }),
    );

    const importersRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "helper", relation: "importers", scope: "src" }),
    );
    const importers = parseToolResult<{ records: Array<{ file: string; module?: string }> }>(
      importersRaw,
    );
    expect(importers.records).toContainEqual(
      expect.objectContaining({ file: "src/b.ts", module: "./a" }),
    );
  });

  it("does not expose resolved paths for relative imports outside the project root", async () => {
    const outsideRoot = `${tmp}-outside`;
    mkdirSync(outsideRoot, { recursive: true });
    try {
      writeFileSync(join(outsideRoot, "external.ts"), "export function externalHelper() {}\n");
      writeProjectFile(
        tmp,
        "src/b.ts",
        [
          `import { externalHelper } from "../../${basename(outsideRoot)}/external.ts";`,
          "export function run() { return externalHelper(); }",
        ].join("\n"),
      );

      const importsRaw = await registry.dispatch(
        "find_references",
        JSON.stringify({ symbol: "run", relation: "imports", scope: "src" }),
      );
      const imports = parseToolResult<{ records: Array<{ resolvedPath?: string }> }>(importsRaw);

      expect(imports.records).toHaveLength(1);
      expect(imports.records[0]?.resolvedPath).toBeUndefined();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("resolves aliased named imports through their local binding", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      [
        'import { helper as h } from "./a";',
        "export function aliasRun() { return h(); }",
        "export function wrongRun() { return helper(); }",
      ].join("\n"),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );
    expect(callers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ name: "aliasRun" }),
          confidence: "INFERRED",
          to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
        }),
        expect.objectContaining({
          from: expect.objectContaining({ name: "wrongRun" }),
          confidence: "AMBIGUOUS",
        }),
      ]),
    );
    expect(callers.records.find((record) => record.from?.name === "wrongRun")?.confidence).not.toBe(
      "INFERRED",
    );

    const callees = await findReferences(
      tmp,
      { symbol: "aliasRun", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    );
  });

  it("resolves namespace imports through their receiver", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      [
        'import * as ns from "./a";',
        "const obj = { helper: () => 2 };",
        "export function nsRun() { return ns.helper(); }",
        "export function wrongRun() { return helper(); }",
        "export function objRun() { return obj.helper(); }",
      ].join("\n"),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );
    expect(callers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ name: "nsRun" }),
          confidence: "INFERRED",
          to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
        }),
        expect.objectContaining({
          from: expect.objectContaining({ name: "wrongRun" }),
          confidence: "AMBIGUOUS",
        }),
      ]),
    );

    const callees = await findReferences(
      tmp,
      { symbol: "nsRun", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    );
  });

  it("keeps default imports distinct from named exports in immediate caller lookup", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      ['import helper from "./a";', "export function run() { return helper(); }"].join("\n"),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );

    expect(callers.records).toEqual([]);

    const importers = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(importers.records).toEqual([]);
  });

  it("keeps module-only imports out of symbol importer lookup", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      ["export function helper() { return 1; }", "export function other() { return 2; }"].join(
        "\n",
      ),
    );
    writeProjectFile(tmp, "src/side-effect.ts", 'import "./a";\n');
    writeProjectFile(tmp, "src/other.ts", 'import { other } from "./a";\n');
    writeProjectFile(tmp, "src/alias.ts", 'import { other as helper } from "./a";\nhelper();\n');
    writeProjectFile(tmp, "src/namespace.ts", 'import * as ns from "./a";\nns.helper();\n');

    const symbolImporters = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(symbolImporters.records).toEqual([
      expect.objectContaining({
        file: "src/namespace.ts",
        reason: "namespace import binding",
      }),
    ]);

    const pathImporters = await findReferences(
      tmp,
      { symbol: "src/a.ts", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(pathImporters.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/namespace.ts" }),
        expect.objectContaining({ file: "src/alias.ts" }),
        expect.objectContaining({ file: "src/other.ts" }),
        expect.objectContaining({ file: "src/side-effect.ts" }),
      ]),
    );
  });

  it("keeps unrelated named re-exports out of symbol importer lookup", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      ["export function helper() { return 1; }", "export function other() { return 2; }"].join(
        "\n",
      ),
    );
    writeProjectFile(tmp, "src/reexport-helper.ts", 'export { helper as h } from "./a";\n');
    writeProjectFile(tmp, "src/reexport-other.ts", 'export { other } from "./a";\n');
    writeProjectFile(tmp, "src/reexport-star.ts", 'export * from "./a";\n');

    const importers = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(importers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "src/reexport-helper.ts",
          reason: "import-scoped binding",
        }),
        expect.objectContaining({
          file: "src/reexport-star.ts",
          reason: "resolved import source",
        }),
      ]),
    );
    expect(importers.records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ file: "src/reexport-other.ts" })]),
    );
  });

  it("resolves named default exports through default imports in immediate caller lookup", async () => {
    writeProjectFile(tmp, "src/a.ts", "export default function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      ['import localHelper from "./a";', "export function run() { return localHelper(); }"].join(
        "\n",
      ),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );
    expect(callers.records).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    ]);

    const callees = await findReferences(
      tmp,
      { symbol: "run", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    );

    const importers = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(importers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        module: "./a",
        confidence: "INFERRED",
        reason: "default import binding",
      }),
    );
  });

  it("resolves named default exports through named default imports", async () => {
    writeProjectFile(tmp, "src/a.ts", "export default function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      [
        'import { default as localHelper } from "./a";',
        "export function run() { return localHelper(); }",
      ].join("\n"),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );
    expect(callers.records).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    ]);

    const callees = await findReferences(
      tmp,
      { symbol: "run", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    );

    const importers = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(importers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        module: "./a",
        confidence: "INFERRED",
        reason: "default import binding",
      }),
    );
  });

  it("resolves named default exports through default re-exports in importer lookup", async () => {
    writeProjectFile(tmp, "src/a.ts", "export default function helper() { return 1; }\n");
    writeProjectFile(tmp, "src/b.ts", 'export { default as exportedHelper } from "./a";\n');

    const importers = await findReferences(
      tmp,
      { symbol: "helper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(importers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        module: "./a",
        confidence: "INFERRED",
        reason: "default re-export binding",
      }),
    );

    const aliasImporters = await findReferences(
      tmp,
      { symbol: "exportedHelper", relation: "importers", scope: "src" },
      { codeGraph: false },
    );
    expect(aliasImporters.records).toEqual([]);
  });

  it("does not treat type-only imports as immediate caller bindings", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      ['import type { helper } from "./a";', "export function run() { return helper(); }"].join(
        "\n",
      ),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );

    expect(callers.records).toEqual([]);

    const callees = await findReferences(
      tmp,
      { symbol: "run", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toEqual([]);
  });

  it("does not treat type-only namespace imports as immediate caller bindings", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      ['import type * as ns from "./a";', "export function run() { return ns.helper(); }"].join(
        "\n",
      ),
    );

    const callers = await findReferences(
      tmp,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraph: false },
    );
    expect(callers.records).toEqual([]);

    const callees = await findReferences(
      tmp,
      { symbol: "run", relation: "callees", scope: "src" },
      { codeGraph: false },
    );
    expect(callees.records).toEqual([]);
  });

  it("find_references callers supports qualified method queries without external false positives", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      [
        "export class Foo {",
        "  method() { return 1; }",
        "}",
        "export function callLocal(foo: Foo) { return foo.method(); }",
      ].join("\n"),
    );

    const qualifiedRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "Foo.method", relation: "callers", scope: "src" }),
    );
    const qualified = parseToolResult<{
      records: Array<{ file: string; from?: { name: string }; to?: { parent?: string } }>;
    }>(qualifiedRaw);
    expect(qualified.records).toContainEqual(
      expect.objectContaining({
        file: "src/a.ts",
        from: expect.objectContaining({ name: "callLocal" }),
        to: expect.objectContaining({ parent: "Foo" }),
      }),
    );

    const unknownRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "Missing.method", relation: "callers", scope: "src" }),
    );
    const unknown = parseToolResult<{ records: unknown[] }>(unknownRaw);
    expect(unknown.records).toEqual([]);
  });

  it("keeps duplicate method names ambiguous instead of guessing a qualified owner", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      [
        "export class Foo {",
        "  method() { return 1; }",
        "}",
        "export class Bar {",
        "  method() { return 2; }",
        "}",
        "export function callFoo(foo: Foo) { return foo.method(); }",
        "export function callBar(bar: Bar) { return bar.method(); }",
      ].join("\n"),
    );

    const qualifiedRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "Foo.method", relation: "callers", scope: "src" }),
    );
    const qualified = parseToolResult<{ records: unknown[] }>(qualifiedRaw);
    expect(qualified.records).toEqual([]);

    const unqualifiedRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "method", relation: "callers", scope: "src" }),
    );
    const unqualified = parseToolResult<{
      records: Array<{ confidence: string; from?: { name: string }; to?: unknown }>;
    }>(unqualifiedRaw);
    expect(unqualified.records).toHaveLength(2);
    expect(unqualified.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "AMBIGUOUS",
          from: expect.objectContaining({ name: "callFoo" }),
        }),
        expect.objectContaining({
          confidence: "AMBIGUOUS",
          from: expect.objectContaining({ name: "callBar" }),
        }),
      ]),
    );
    expect(unqualified.records.every((record) => record.to === undefined)).toBe(true);
  });

  it("impact groups shallow caller depth and hard-caps requested depth at 2", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      tmp,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    writeProjectFile(
      tmp,
      "src/c.ts",
      'import { run } from "./b";\nexport function top() { return run(); }\n',
    );

    const raw = await registry.dispatch(
      "impact",
      JSON.stringify({ symbol: "helper", maxDepth: 5, minConfidence: "INFERRED", scope: "src" }),
    );
    const parsed = parseToolResult<{
      requestedDepth: number;
      maxDepth: number;
      capped: boolean;
      groups: Array<{ depth: number; records: Array<{ from?: { name: string } }> }>;
    }>(raw);
    expect(parsed.requestedDepth).toBe(5);
    expect(parsed.maxDepth).toBe(2);
    expect(parsed.capped).toBe(true);
    expect(parsed.groups[0]).toMatchObject({
      depth: 1,
      records: [expect.objectContaining({ from: expect.objectContaining({ name: "run" }) })],
    });
    expect(parsed.groups[1]).toMatchObject({
      depth: 2,
      records: [expect.objectContaining({ from: expect.objectContaining({ name: "top" }) })],
    });
  });

  it("impact truncates candidate explosions", async () => {
    writeProjectFile(tmp, "src/target.ts", "export function target() { return 1; }\n");
    for (let i = 0; i < 105; i++) {
      writeProjectFile(
        tmp,
        `src/caller-${String(i).padStart(3, "0")}.ts`,
        `export function caller${i}() { return target(); }\n`,
      );
    }

    const raw = await registry.dispatch(
      "impact",
      JSON.stringify({ symbol: "target", maxDepth: 1, scope: "src" }),
    );
    const parsed = parseToolResult<{
      truncated: boolean;
      groups: Array<{ records: Array<{ from?: { name: string } }> }>;
    }>(raw);
    expect(parsed.truncated).toBe(true);
    expect(parsed.groups[0]?.records).toHaveLength(100);
  }, 15_000);

  it("detect_changes maps git diff hunks to affected symbols and optional callers", async () => {
    writeProjectFile(
      tmp,
      "src/a.ts",
      [
        "export function helper() {",
        "  return 1;",
        "}",
        "export function run() {",
        "  return helper();",
        "}",
      ].join("\n"),
    );
    initGitRepo(tmp);
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "init"]);
    writeProjectFile(
      tmp,
      "src/a.ts",
      [
        "export function helper() {",
        "  return 2;",
        "}",
        "export function run() {",
        "  return helper();",
        "}",
      ].join("\n"),
    );

    const raw = await registry.dispatch(
      "detect_changes",
      JSON.stringify({ scope: "unstaged", includeCallers: true }),
    );
    const parsed = parseToolResult<{
      changedFiles: Array<{ path: string; symbols: Array<{ name: string }> }>;
      callers?: Array<{ symbol: string; records: Array<{ from?: { name: string } }> }>;
    }>(raw);
    expect(parsed.changedFiles).toContainEqual(
      expect.objectContaining({
        path: "src/a.ts",
        symbols: [expect.objectContaining({ name: "helper" })],
      }),
    );
    expect(parsed.callers).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        records: [expect.objectContaining({ from: expect.objectContaining({ name: "run" }) })],
      }),
    );
  });

  it("detect_changes handles moved files and conservative formatting-only line drift", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() {\n  return 1;\n}\n");
    initGitRepo(tmp);
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "init"]);
    mkdirSync(join(tmp, "lib"), { recursive: true });
    git(tmp, ["mv", "src/a.ts", "lib/a.ts"]);
    writeProjectFile(tmp, "lib/a.ts", "export function helper() {\n  return 2;\n}\n");
    git(tmp, ["add", "."]);

    const movedRaw = await registry.dispatch("detect_changes", JSON.stringify({ scope: "staged" }));
    const moved = parseToolResult<{
      changedFiles: Array<{ path: string; symbols: Array<{ name: string }> }>;
    }>(movedRaw);
    expect(moved.changedFiles).toContainEqual(
      expect.objectContaining({
        path: "lib/a.ts",
        symbols: [expect.objectContaining({ name: "helper" })],
      }),
    );

    git(tmp, ["commit", "-m", "move"]);
    writeProjectFile(tmp, "lib/a.ts", "\nexport function helper() {\n  return 2;\n}\n");
    const formatRaw = await registry.dispatch(
      "detect_changes",
      JSON.stringify({ scope: "unstaged" }),
    );
    const formatted = parseToolResult<{
      changedFiles: Array<{ path: string; symbols: Array<{ name: string }> }>;
    }>(formatRaw);
    expect(formatted.changedFiles).toContainEqual(
      expect.objectContaining({ path: "lib/a.ts", symbols: [] }),
    );
  });

  it("token benchmark: one relation query is smaller than manual grep plus reads", async () => {
    writeProjectFile(tmp, "src/target.ts", "export function target() { return 1; }\n");
    const manualParts: string[] = [];
    const grepLines: string[] = [];
    for (let i = 0; i < 8; i++) {
      const path = `src/caller-${i}.ts`;
      const content = [
        'import { target } from "./target";',
        `export function caller${i}() {`,
        "  return target();",
        "}",
        ...Array.from({ length: 28 }, (_, n) => `export const filler${i}_${n} = ${n};`),
      ].join("\n");
      writeProjectFile(tmp, path, content);
      manualParts.push(`read_file ${path}\n${content}`);
      grepLines.push(`${path}:3:  return target();`);
    }

    const relationRaw = await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "target", relation: "callers", scope: "src" }),
    );
    const relationTokens = countTokensBounded(relationRaw);
    const manualTokens = countTokensBounded(
      ["search_content target\\(", ...grepLines, ...manualParts].join("\n"),
    );
    expect(relationTokens).toBeLessThan(manualTokens);
    expect(manualTokens - relationTokens).toBeGreaterThan(100);
  });

  it("keeps code relation dispatch out of the immutable prefix and lets scavenge recover names", async () => {
    writeProjectFile(tmp, "src/a.ts", "export function helper() { return 1; }\n");
    const prefix = new ImmutablePrefix({ system: "s", toolSpecs: registry.specs() });
    const before = prefix.fingerprint;
    await registry.dispatch(
      "find_references",
      JSON.stringify({ symbol: "helper", relation: "callers", scope: "src" }),
    );
    expect(prefix.verifyFingerprint()).toBe(before);

    const allowedNames = new Set(prefix.toolSpecs.map((spec) => spec.function.name));
    const scavenged = scavengeToolCalls(
      '{"name":"detect_changes","arguments":{"scope":"unstaged"}}',
      { allowedNames },
    );
    expect(scavenged.calls[0]?.function.name).toBe("detect_changes");
  });
});

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildCodeGraphCommand } from "../src/cli/commands/code-index.js";
import { runDoctorChecks } from "../src/cli/commands/doctor.js";
import {
  detectChanges,
  findReferences,
  impact,
  resetCodeGraphBuildCooldown,
} from "../src/code-query/relations.js";
import { buildCodeGraph, incrementalUpdate } from "../src/index/code-graph/builder.js";
import { diffStaleStamps } from "../src/index/code-graph/hash.js";
import { loadCodeGraph } from "../src/index/code-graph/loader.js";
import {
  getCodeGraphStats,
  readCodeGraphArtifactStats,
  resetCodeGraphStats,
} from "../src/index/code-graph/stats.js";
import { codeGraphPaths, hashGraphArtifacts } from "../src/index/code-graph/writer.js";
import { Bm25Index } from "../src/index/lexical/bm25.js";

interface NodesFile {
  nodes: Array<{
    name: string;
    id: string;
    kind: string;
    file: string;
    exportKind?: string;
    signature?: string;
    docstring?: string;
  }>;
}

interface EdgesFile {
  edges: Array<{
    source: string;
    target: string;
    kind: string;
    provenance: string;
    candidates?: unknown[];
  }>;
}

interface FileStampsFile {
  files: Record<string, { mtimeMs: number; size: number }>;
}

function writeProjectFile(root: string, file: string, content: string): void {
  const full = join(root, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadFileStamps(root: string): FileStampsFile["files"] {
  return readJson<FileStampsFile>(codeGraphPaths(root).filesStamps).files;
}

function rewriteGraphHashes(root: string): void {
  const paths = codeGraphPaths(root);
  const targets = [paths.nodes, paths.edges, paths.bm25, paths.filesStamps];
  const payloads = targets.map((target) => graphHashPayload(readFileSync(target, "utf8")));
  const graphHash = hashGraphArtifacts(payloads);
  for (const target of targets) {
    writeFileSync(target, withGraphHash(readFileSync(target, "utf8"), graphHash));
  }
}

function graphHashPayload(raw: string): string {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify(withoutGraphHash(value));
}

function withGraphHash(raw: string, graphHash: string): string {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...withoutGraphHash(value), graphHash });
}

function withoutGraphHash(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "graphHash"));
}

async function waitForMtimeTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function initGitRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Reasonix Test"]);
}

describe("code graph v4 index", () => {
  let root: string;
  let originalCodeGraph: string | undefined;
  let originalCodeGraphBody: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-code-graph-"));
    resetCodeGraphStats();
    resetCodeGraphBuildCooldown();
    originalCodeGraph = process.env.REASONIX_CODE_GRAPH;
    originalCodeGraphBody = process.env.REASONIX_CODE_GRAPH_BODY;
    process.env.REASONIX_CODE_GRAPH = "1";
    // biome-ignore lint/performance/noDelete: tests pin body fields explicitly per case
    delete process.env.REASONIX_CODE_GRAPH_BODY;
  });

  afterEach(() => {
    if (originalCodeGraph === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.REASONIX_CODE_GRAPH;
    } else {
      process.env.REASONIX_CODE_GRAPH = originalCodeGraph;
    }
    if (originalCodeGraphBody === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.REASONIX_CODE_GRAPH_BODY;
    } else {
      process.env.REASONIX_CODE_GRAPH_BODY = originalCodeGraphBody;
    }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  it("builds nodes, edges, BM25, and file stamps as JSON artifacts", async () => {
    writeProjectFile(
      root,
      "src/a.ts",
      [
        "export interface Runnable {}",
        "export class Base {}",
        "export function helper() { return 1; }",
      ].join("\n"),
    );
    writeProjectFile(
      root,
      "src/b.ts",
      [
        'import { helper, Base, Runnable } from "./a";',
        "export class Worker extends Base implements Runnable {",
        "  run() { return helper(); }",
        "}",
      ].join("\n"),
    );

    const result = await buildCodeGraph(root);
    const paths = codeGraphPaths(root);

    expect(result.filesScanned).toBe(2);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.edges).toBeGreaterThan(0);
    expect(existsSync(paths.nodes)).toBe(true);
    expect(existsSync(paths.edges)).toBe(true);
    expect(existsSync(paths.bm25)).toBe(true);
    expect(existsSync(paths.filesStamps)).toBe(true);

    const nodesFile = readJson<NodesFile>(paths.nodes);
    const edgesFile = readJson<EdgesFile>(paths.edges);
    expect(nodesFile.nodes.map((node) => node.name)).toEqual(
      expect.arrayContaining(["Base", "Runnable", "Worker", "helper", "run"]),
    );
    expect(nodesFile.nodes.some((node) => node.signature || node.docstring)).toBe(false);
    expect(edgesFile.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(["call", "contains", "extends", "implements", "import"]),
    );
    expect(edgesFile.edges.map((edge) => edge.provenance)).toEqual(
      expect.arrayContaining(["extracted", "inferred"]),
    );
    expect(Bm25Index.load(readFileSync(paths.bm25, "utf8")).size).toBe(nodesFile.nodes.length);
  });

  it("keeps body fields out by default while allowing explicit opt-in", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["/** explains helper */", "export function helper() { return 1; }"].join("\n"),
    );

    await buildCodeGraph(root, { includeBody: false });
    let nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);
    let helper = nodesFile.nodes.find((node) => node.name === "helper");
    expect(helper?.signature).toBeUndefined();
    expect(helper?.docstring).toBeUndefined();

    await buildCodeGraph(root, { includeBody: true });
    nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);
    helper = nodesFile.nodes.find((node) => node.name === "helper");
    expect(helper?.signature).toContain("export function helper");
    expect(helper?.docstring).toBe("explains helper");
  });

  it("writes byte-identical artifacts across unchanged rebuilds", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );

    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const first = [
      readFileSync(paths.nodes, "utf8"),
      readFileSync(paths.edges, "utf8"),
      readFileSync(paths.bm25, "utf8"),
      readFileSync(paths.filesStamps, "utf8"),
    ];

    await buildCodeGraph(root);
    expect([
      readFileSync(paths.nodes, "utf8"),
      readFileSync(paths.edges, "utf8"),
      readFileSync(paths.bm25, "utf8"),
      readFileSync(paths.filesStamps, "utf8"),
    ]).toEqual(first);
  });

  it("keeps concurrent same-process rebuilds from sharing temp files", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");

    const results = await Promise.all([buildCodeGraph(root), buildCodeGraph(root)]);
    const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);

    expect(results.map((result) => result.filesScanned)).toEqual([1, 1]);
    expect(nodesFile.nodes.map((node) => node.name)).toEqual(["helper"]);
  });

  it("rebuild command emits JSON summary for the CLI entry", async () => {
    writeProjectFile(root, "src/mod.ts", "export function run() { return 1; }\n");
    const originalWrite = process.stdout.write;
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await rebuildCodeGraphCommand({ dir: root, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }

    const parsed = JSON.parse(out) as {
      filesScanned: number;
      nodes: number;
      edges: number;
    };
    expect(parsed.filesScanned).toBe(1);
    expect(parsed.nodes).toBe(1);
    expect(codeGraphPaths(root).nodes).toContain(".reasonix/index/code-graph/nodes.json");
  });

  it("rebuild command honors REASONIX_CODE_GRAPH=0 without creating artifacts", async () => {
    writeProjectFile(root, "src/mod.ts", "export function run() { return 1; }\n");
    const originalEnv = process.env.REASONIX_CODE_GRAPH;
    const originalWrite = process.stdout.write;
    let out = "";
    process.env.REASONIX_CODE_GRAPH = "0";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await rebuildCodeGraphCommand({ dir: root, json: true });
    } finally {
      process.stdout.write = originalWrite;
      if (originalEnv === undefined) {
        // biome-ignore lint/performance/noDelete: restore exact env state
        delete process.env.REASONIX_CODE_GRAPH;
      } else {
        process.env.REASONIX_CODE_GRAPH = originalEnv;
      }
    }

    expect(JSON.parse(out)).toMatchObject({ disabled: true });
    expect(existsSync(codeGraphPaths(root).nodes)).toBe(false);
  });

  it("loads graph artifacts and serves find_references caller and callee lookups", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a.js";\nexport function run() { return helper(); }\n',
    );
    await buildCodeGraph(root);

    const graph = await loadCodeGraph(root);
    expect(graph?.nodesByName.get("helper")).toHaveLength(1);

    const callers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    expect(callers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
      }),
    );

    const callees = await findReferences(root, {
      symbol: "run",
      relation: "callees",
      scope: "src",
    });
    expect(callees.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        symbol: "helper",
        confidence: "INFERRED",
      }),
    );
  });

  it("builds the graph synchronously on first caller lookup when artifacts are missing", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );

    const callers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const stats = getCodeGraphStats();

    expect(existsSync(codeGraphPaths(root).nodes)).toBe(true);
    expect(stats.builds).toBe(1);
    expect(stats.fallbacks).toBe(0);
    expect(callers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
      }),
    );
  });

  it("falls back to immediate lookup when the first graph build times out", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );

    const callers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraphBuildTimeoutMs: 0 },
    );
    const stats = getCodeGraphStats();
    const checks = await runDoctorChecks(root);

    expect(existsSync(codeGraphPaths(root).nodes)).toBe(false);
    expect(stats).toMatchObject({
      builds: 0,
      buildTimeouts: 1,
      queries: 1,
      fallbacks: 1,
      lastBuildTimeoutMs: 0,
    });
    expect(callers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(checks.find((check) => check.id === "code-graph")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("build-timeout=0ms"),
    });
  });

  it("uses the graph-backed caller lookup for detect_changes includeCallers", async () => {
    writeProjectFile(
      root,
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
    initGitRepo(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "init"]);
    writeProjectFile(
      root,
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

    const result = await detectChanges(root, {
      scope: "unstaged",
      includeCallers: true,
    });
    const stats = getCodeGraphStats();

    expect(existsSync(codeGraphPaths(root).nodes)).toBe(true);
    expect(stats.builds).toBe(1);
    expect(stats.fallbacks).toBe(0);
    expect(result.callers).toContainEqual(
      expect.objectContaining({
        symbol: "helper",
        records: [
          expect.objectContaining({
            from: expect.objectContaining({ name: "run" }),
          }),
        ],
      }),
    );
  });

  it("uses graph-backed import metadata for imports and importers", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    writeProjectFile(root, "src/c.ts", 'import "./a";\nexport const c = 1;\n');
    await buildCodeGraph(root);
    const graphOpts = { codeGraphStaleTimeoutMs: 2_000 };

    const graphImports = await findReferences(
      root,
      {
        symbol: "run",
        relation: "imports",
        scope: "src",
      },
      graphOpts,
    );
    const immediateImports = await findReferences(
      root,
      { symbol: "run", relation: "imports", scope: "src" },
      { codeGraph: false },
    );
    const graphImporters = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "importers",
        scope: "src",
      },
      graphOpts,
    );
    const graphFileImporters = await findReferences(
      root,
      {
        symbol: "src/a.ts",
        relation: "importers",
        scope: "src",
      },
      graphOpts,
    );
    const stats = getCodeGraphStats();

    expect(stats.fallbacks).toBe(0);
    expect(graphImports.records).toEqual(immediateImports.records);
    expect(graphImporters.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        module: "./a",
        names: ["helper"],
        resolvedPath: "src/a.ts",
        snippet: 'import { helper } from "./a";',
      }),
    );
    expect(graphFileImporters.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/b.ts", module: "./a" }),
        expect.objectContaining({ file: "src/c.ts", module: "./a" }),
      ]),
    );
  });

  it("keeps qualified method caller lookups aligned with the immediate fallback", async () => {
    writeProjectFile(
      root,
      "src/a.ts",
      [
        "export class Foo {",
        "  method() { return 1; }",
        "}",
        "export function callLocal(foo: Foo) { return foo.method(); }",
      ].join("\n"),
    );
    await buildCodeGraph(root);

    const graph = await findReferences(root, {
      symbol: "Foo.method",
      relation: "callers",
      scope: "src",
    });
    const immediate = await findReferences(
      root,
      {
        symbol: "Foo.method",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );

    const comparable = (records: typeof graph.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));
    expect(comparable(graph.records)).toEqual(comparable(immediate.records));
    expect(graph.records).toContainEqual(
      expect.objectContaining({
        file: "src/a.ts",
        from: expect.objectContaining({ name: "callLocal" }),
        to: expect.objectContaining({ parent: "Foo" }),
      }),
    );
  });

  it("keeps duplicate method caller lookups ambiguous instead of guessing a qualified owner", async () => {
    writeProjectFile(
      root,
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
    await buildCodeGraph(root);

    const graphQualified = await findReferences(root, {
      symbol: "Foo.method",
      relation: "callers",
      scope: "src",
    });
    const immediateQualified = await findReferences(
      root,
      {
        symbol: "Foo.method",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    expect(graphQualified.records).toEqual([]);
    expect(immediateQualified.records).toEqual([]);

    const graphUnqualified = await findReferences(root, {
      symbol: "method",
      relation: "callers",
      scope: "src",
    });
    const immediateUnqualified = await findReferences(
      root,
      {
        symbol: "method",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const comparable = (records: typeof graphUnqualified.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));
    expect(comparable(graphUnqualified.records)).toEqual(comparable(immediateUnqualified.records));
    expect(graphUnqualified.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ confidence: "AMBIGUOUS" })]),
    );
    expect(graphUnqualified.records.every((record) => record.to === undefined)).toBe(true);
  });

  it("does not treat side-effect imports as call bindings", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import "./a";\nexport function run() { return missing(); }\n',
    );
    await buildCodeGraph(root);

    const graph = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediate = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );

    expect(graph.records).toEqual([]);
    expect(immediate.records).toEqual([]);
  });

  it("keeps aliased named import call resolution aligned with the immediate fallback", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      [
        'import { helper as h } from "./a";',
        "export function aliasRun() { return h(); }",
        "export function wrongRun() { return helper(); }",
      ].join("\n"),
    );
    await buildCodeGraph(root);

    const graphCallers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediateCallers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const graphCallees = await findReferences(root, {
      symbol: "aliasRun",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "aliasRun",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );
    const comparable = (records: typeof graphCallers.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));

    expect(comparable(graphCallers.records)).toEqual(comparable(immediateCallers.records));
    expect(comparable(graphCallees.records)).toEqual(comparable(immediateCallees.records));
    expect(graphCallers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ name: "aliasRun" }),
          confidence: "INFERRED",
          to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
        }),
      ]),
    );
    expect(
      graphCallers.records.find((record) => record.from?.name === "wrongRun")?.confidence,
    ).toBe("AMBIGUOUS");
  });

  it("keeps namespace import call resolution aligned with the immediate fallback", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      [
        'import * as ns from "./a";',
        "const obj = { helper: () => 2 };",
        "export function nsRun() { return ns.helper(); }",
        "export function wrongRun() { return helper(); }",
        "export function objRun() { return obj.helper(); }",
      ].join("\n"),
    );
    await buildCodeGraph(root);

    const graphCallers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediateCallers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const graphCallees = await findReferences(root, {
      symbol: "nsRun",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "nsRun",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );
    const comparable = (records: typeof graphCallers.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));

    expect(comparable(graphCallers.records)).toEqual(comparable(immediateCallers.records));
    expect(comparable(graphCallees.records)).toEqual(comparable(immediateCallees.records));
    expect(graphCallers.records).toEqual(
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
  });

  it("keeps default imports distinct from named exports in graph-backed caller lookup", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      ['import helper from "./a";', "export function run() { return helper(); }"].join("\n"),
    );
    await buildCodeGraph(root);

    const graph = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediate = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );

    expect(graph.records).toEqual([]);
    expect(immediate.records).toEqual([]);
  });

  it("keeps named default export call resolution aligned with the immediate fallback", async () => {
    writeProjectFile(root, "src/a.ts", "export default function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      ['import localHelper from "./a";', "export function run() { return localHelper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);

    const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);
    expect(nodesFile.nodes.find((node) => node.name === "helper")).toMatchObject({
      exportKind: "default",
    });

    const graphCallers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediateCallers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const graphCallees = await findReferences(root, {
      symbol: "run",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "run",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );
    const comparable = (records: typeof graphCallers.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));

    expect(comparable(graphCallers.records)).toEqual(comparable(immediateCallers.records));
    expect(comparable(graphCallees.records)).toEqual(comparable(immediateCallees.records));
    expect(graphCallers.records).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    ]);
  });

  it("keeps named default import syntax aligned with the immediate fallback", async () => {
    writeProjectFile(root, "src/a.ts", "export default function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      [
        'import { default as localHelper } from "./a";',
        "export function run() { return localHelper(); }",
      ].join("\n"),
    );
    await buildCodeGraph(root);

    const graphCallers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediateCallers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const graphCallees = await findReferences(root, {
      symbol: "run",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "run",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );
    const comparable = (records: typeof graphCallers.records) =>
      records.map(({ file, line, column, relation, symbol, confidence, from, to }) => ({
        file,
        line,
        column,
        relation,
        symbol,
        confidence,
        from,
        to,
      }));

    expect(comparable(graphCallers.records)).toEqual(comparable(immediateCallers.records));
    expect(comparable(graphCallees.records)).toEqual(comparable(immediateCallees.records));
    expect(graphCallers.records).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
        confidence: "INFERRED",
        to: expect.objectContaining({ name: "helper", file: "src/a.ts" }),
      }),
    ]);
  });

  it("does not treat type-only imports as graph-backed caller bindings", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      ['import type { helper } from "./a";', "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);

    const graph = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediate = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );

    expect(graph.records).toEqual([]);
    expect(immediate.records).toEqual([]);

    const graphCallees = await findReferences(root, {
      symbol: "run",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "run",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );
    expect(graphCallees.records).toEqual([]);
    expect(immediateCallees.records).toEqual([]);
  });

  it("does not treat type-only namespace imports as graph-backed caller bindings", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      ['import type * as ns from "./a";', "export function run() { return ns.helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);

    const graphCallers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const immediateCallers = await findReferences(
      root,
      {
        symbol: "helper",
        relation: "callers",
        scope: "src",
      },
      { codeGraph: false },
    );
    const graphCallees = await findReferences(root, {
      symbol: "run",
      relation: "callees",
      scope: "src",
    });
    const immediateCallees = await findReferences(
      root,
      {
        symbol: "run",
        relation: "callees",
        scope: "src",
      },
      { codeGraph: false },
    );

    expect(graphCallers.records).toEqual([]);
    expect(immediateCallers.records).toEqual([]);
    expect(graphCallees.records).toEqual([]);
    expect(immediateCallees.records).toEqual([]);
  });

  it("does not turn comments and strings into graph-backed caller edges", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      [
        "export function run() {",
        '  const text = "helper()";',
        "  // helper()",
        "  return text;",
        "}",
      ].join("\n"),
    );
    await buildCodeGraph(root);

    const callers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });

    expect(callers.records).toEqual([]);
  });

  it("does not resolve relative imports outside the project root", async () => {
    const outsideRoot = `${root}-sibling`;
    mkdirSync(outsideRoot, { recursive: true });
    try {
      writeFileSync(join(outsideRoot, "a.ts"), "export function externalHelper() { return 99; }\n");
      writeProjectFile(root, "sibling/a.ts", "export function externalHelper() { return 1; }\n");
      writeProjectFile(root, "other/a.ts", "export function externalHelper() { return 2; }\n");
      writeProjectFile(
        root,
        "src/b.ts",
        [
          `import { externalHelper } from "../../${basename(outsideRoot)}/a.js";`,
          "export function run() { return externalHelper(); }",
        ].join("\n"),
      );

      await buildCodeGraph(root);
      const result = await findReferences(root, {
        symbol: "externalHelper",
        relation: "callers",
        scope: "src",
      });

      const runRecord = result.records.find(
        (record) => record.file === "src/b.ts" && record.from?.name === "run",
      );
      expect(runRecord).toMatchObject({ confidence: "AMBIGUOUS" });
      expect(runRecord?.to).toBeUndefined();
    } finally {
      rmSync(outsideRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it("reports artifact and telemetry counts without symbol names", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    const build = await buildCodeGraph(root);
    const artifact = await readCodeGraphArtifactStats(root);
    await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });

    expect(artifact).toMatchObject({
      nodes: build.nodes,
      edges: build.edges,
      files: 2,
      stalenessRatio: 0,
    });
    const stats = getCodeGraphStats();
    expect(stats).toMatchObject({
      builds: 1,
      queries: 1,
      lastNodes: build.nodes,
      lastEdges: build.edges,
    });
    expect(JSON.stringify(stats)).not.toContain("helper");

    const checks = await runDoctorChecks(root);
    expect(checks.find((check) => check.id === "code-graph")).toMatchObject({
      level: "ok",
      detail: expect.stringContaining(`nodes=${build.nodes}`),
    });
  });

  it("rejects graph artifacts with node kinds outside the schema", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const nodesFile = readJson<NodesFile>(paths.nodes);
    const first = nodesFile.nodes[0];
    if (!first) throw new Error("expected a node artifact");
    first.kind = "bogus";
    writeFileSync(paths.nodes, JSON.stringify(nodesFile));
    rewriteGraphHashes(root);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph node kind");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow("invalid code graph node kind");
  });

  it("rejects graph artifacts with edge provenance outside the schema", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const edgesFile = readJson<EdgesFile>(paths.edges);
    const first = edgesFile.edges[0];
    if (!first) throw new Error("expected an edge artifact");
    first.provenance = "bogus";
    writeFileSync(paths.edges, JSON.stringify(edgesFile));
    rewriteGraphHashes(root);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph edge provenance");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "invalid code graph edge provenance",
    );
  });

  it("rejects graph artifacts with non-string edge candidates", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const edgesFile = readJson<EdgesFile>(paths.edges);
    const first = edgesFile.edges[0];
    if (!first) throw new Error("expected an edge artifact");
    first.candidates = [1];
    writeFileSync(paths.edges, JSON.stringify(edgesFile));
    rewriteGraphHashes(root);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph edge candidates");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "invalid code graph edge candidates",
    );
  });

  it("rejects graph artifacts with invalid BM25 payloads", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const bm25File = readJson<Record<string, unknown>>(paths.bm25);
    bm25File.docs = "bogus";
    writeFileSync(paths.bm25, JSON.stringify(bm25File));
    rewriteGraphHashes(root);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid BM25 docs");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow("invalid BM25 docs");
  });

  it("rejects graph artifacts with dangling edge endpoints", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const nodesFile = readJson<NodesFile>(paths.nodes);
    const edgesFile = readJson<EdgesFile>(paths.edges);
    const firstEdge = edgesFile.edges[0];
    if (!firstEdge) throw new Error("expected an edge artifact");
    nodesFile.nodes = nodesFile.nodes.filter((node) => node.id !== firstEdge.target);
    writeFileSync(paths.nodes, JSON.stringify(nodesFile));
    rewriteGraphHashes(root);

    await expect(loadCodeGraph(root)).rejects.toThrow("dangling code graph edge target");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "dangling code graph edge target",
    );
  });

  it("rejects graph artifacts with mismatched artifact hashes", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const filesFile = readJson<Record<string, unknown>>(paths.filesStamps);
    filesFile.graphHash = "different";
    writeFileSync(paths.filesStamps, JSON.stringify(filesFile));

    await expect(loadCodeGraph(root)).rejects.toThrow("mismatched code graph artifacts");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "mismatched code graph artifacts",
    );
  });

  it("rejects graph artifacts whose content no longer matches the shared hash", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    const nodesFile = readJson<NodesFile>(paths.nodes);
    nodesFile.nodes = [];
    writeFileSync(paths.nodes, JSON.stringify(nodesFile));

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph artifact hash");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "invalid code graph artifact hash",
    );
  });

  it("does not reuse a cached graph when same-size artifacts are rewritten", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    await expect(loadCodeGraph(root)).resolves.toBeTruthy();

    const beforeStat = statSync(paths.nodes);
    const beforeRaw = readFileSync(paths.nodes, "utf8");
    const afterRaw = beforeRaw.replace("helper", "boguss");
    expect(afterRaw.length).toBe(beforeRaw.length);
    writeFileSync(paths.nodes, afterRaw);
    utimesSync(paths.nodes, beforeStat.atimeMs / 1000, beforeStat.mtimeMs / 1000);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph artifact hash");
  });

  it("rejects non-file graph artifacts instead of treating the index as missing", async () => {
    writeProjectFile(root, "src/mod.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    const paths = codeGraphPaths(root);
    unlinkSync(paths.nodes);
    mkdirSync(paths.nodes);

    await expect(loadCodeGraph(root)).rejects.toThrow("invalid code graph artifact file");
    await expect(readCodeGraphArtifactStats(root)).rejects.toThrow(
      "invalid code graph artifact file",
    );
  });

  it("detects stale files and refreshes the graph before caller lookup", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);
    await waitForMtimeTick();
    writeProjectFile(
      root,
      "src/mod.ts",
      [
        "export function helper2() { return 2; }",
        "export function run() { return helper2(); }",
      ].join("\n"),
    );

    const result = await findReferences(root, {
      symbol: "helper2",
      relation: "callers",
      scope: "src",
    });

    expect(result.records).toContainEqual(
      expect.objectContaining({
        file: "src/mod.ts",
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(getCodeGraphStats()).toMatchObject({
      builds: 2,
      queries: 1,
      fallbacks: 0,
      stalenessRatio: 0,
    });
    const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);
    expect(nodesFile.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["helper2"]));
  });

  it("detects newly added code files and refreshes the graph before caller lookup", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);
    await waitForMtimeTick();
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );

    const result = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });

    expect(result.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(getCodeGraphStats()).toMatchObject({
      builds: 2,
      queries: 1,
      fallbacks: 0,
      stalenessRatio: 0,
    });
    expect(loadFileStamps(root)["src/b.ts"]).toBeDefined();
  });

  it("splices a stale file without reparsing unrelated files", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    writeProjectFile(root, "src/other.ts", "export function untouched() { return 1; }\n");
    await buildCodeGraph(root);
    const graph = await loadCodeGraph(root);
    await waitForMtimeTick();
    writeProjectFile(
      root,
      "src/mod.ts",
      [
        "export function helper2() { return 2; }",
        "export function run() { return helper2(); }",
      ].join("\n"),
    );

    const result = await incrementalUpdate(root, graph!, ["src/mod.ts"]);
    const updated = await loadCodeGraph(root);

    expect(result.filesScanned).toBe(1);
    expect(updated?.nodesByName.get("helper2")).toHaveLength(1);
    expect(updated?.nodesByName.get("helper")).toBeUndefined();
    expect(updated?.nodesByName.get("untouched")).toHaveLength(1);
  });

  it("re-resolves direct importers when a stale target file changes node ids", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    await buildCodeGraph(root);
    const before = await loadCodeGraph(root);
    const beforeHelper = before?.nodesByName.get("helper")?.[0]?.id;
    await waitForMtimeTick();
    writeProjectFile(
      root,
      "src/a.ts",
      "export const inserted = 1;\nexport function helper() { return 2; }\n",
    );

    const result = await incrementalUpdate(root, before!, ["src/a.ts"]);
    const updated = await loadCodeGraph(root);
    const afterHelper = updated?.nodesByName.get("helper")?.[0]?.id;
    const callers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });

    expect(result.filesScanned).toBe(2);
    expect(afterHelper).toBeDefined();
    expect(afterHelper).not.toBe(beforeHelper);
    expect(callers.records).toContainEqual(
      expect.objectContaining({
        file: "src/b.ts",
        from: expect.objectContaining({ name: "run" }),
        to: expect.objectContaining({ file: "src/a.ts", line: 2 }),
      }),
    );
    expect(getCodeGraphStats()).toMatchObject({
      fallbacks: 0,
      stalenessRatio: 0,
    });
  });

  it("falls back to immediate lookup when stale detection times out", async () => {
    writeProjectFile(
      root,
      "src/mod.ts",
      ["export function helper() { return 1; }", "export function run() { return helper(); }"].join(
        "\n",
      ),
    );
    await buildCodeGraph(root);
    await waitForMtimeTick();
    writeProjectFile(
      root,
      "src/mod.ts",
      [
        "export function helper2() { return 2; }",
        "export function run() { return helper2(); }",
      ].join("\n"),
    );

    const result = await findReferences(
      root,
      {
        symbol: "helper2",
        relation: "callers",
        scope: "src",
      },
      { codeGraphStaleTimeoutMs: 0 },
    );

    expect(result.records).toContainEqual(
      expect.objectContaining({
        file: "src/mod.ts",
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(getCodeGraphStats()).toMatchObject({
      builds: 1,
      queries: 1,
      fallbacks: 1,
    });
    const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);
    expect(nodesFile.nodes.map((node) => node.name)).not.toContain("helper2");
  });

  it("flags size-only file stamp drift without reading file contents", async () => {
    const result = await diffStaleStamps(
      root,
      { "src/a.ts": { mtimeMs: 10, size: 10 } },
      {
        statFile: async () => ({ mtimeMs: 10, size: 11 }),
      },
    );

    expect(result).toMatchObject({
      stale: ["src/a.ts"],
      checked: 1,
      total: 1,
      timedOut: false,
    });
  });

  it("flags current code files missing from file stamps as stale", async () => {
    const result = await diffStaleStamps(
      root,
      { "src/a.ts": { mtimeMs: 10, size: 10 } },
      {
        statFile: async () => ({ mtimeMs: 10, size: 10 }),
        listFiles: async () => ["src/a.ts", "src/b.ts"],
      },
    );

    expect(result).toMatchObject({
      stale: ["src/b.ts"],
      checked: 1,
      total: 2,
      timedOut: false,
    });
  });

  it("treats stamped symlinked code files as stale without following them", async () => {
    const outsideRoot = `${root}-outside`;
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(
      join(outsideRoot, "secret.ts"),
      "export function externalSecret() { return 1; }\n",
    );
    writeProjectFile(root, "src/a.ts", "export function local() { return 1; }\n");
    await buildCodeGraph(root);
    const graph = await loadCodeGraph(root);
    expect(graph?.files["src/a.ts"]).toBeDefined();
    rmSync(join(root, "src/a.ts"));
    let symlinksWorked = true;
    try {
      symlinkSync(join(outsideRoot, "secret.ts"), join(root, "src/a.ts"));
    } catch {
      symlinksWorked = false;
    }
    try {
      if (!symlinksWorked || !graph) return;
      const stale = await diffStaleStamps(root, graph.files, {
        timeoutMs: 1000,
      });
      const artifact = await readCodeGraphArtifactStats(root);

      expect(stale.stale).toEqual(["src/a.ts"]);
      expect(artifact?.stalenessRatio).toBe(1);
    } finally {
      rmSync(outsideRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it("keeps import relations on the immediate fallback until graph stores module metadata", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    await buildCodeGraph(root);

    const imports = await findReferences(root, {
      symbol: "run",
      relation: "imports",
      scope: "src",
    });
    expect(imports.records).toContainEqual(
      expect.objectContaining({
        module: "./a",
        names: expect.arrayContaining(["helper"]),
      }),
    );
  });

  it("keeps graph-backed scope escape handling byte-compatible with the immediate path", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    await buildCodeGraph(root);

    await expect(
      findReferences(root, {
        symbol: "helper",
        relation: "callers",
        scope: "../outside",
      }),
    ).rejects.toThrow("path escapes project root: ../outside");
  });

  it("lets impact reuse graph-backed caller lookups when the index exists", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );
    writeProjectFile(
      root,
      "src/c.ts",
      'import { run } from "./b";\nexport function top() { return run(); }\n',
    );
    await buildCodeGraph(root);

    const result = await impact(root, {
      symbol: "helper",
      maxDepth: 2,
      scope: "src",
    });
    expect(result.groups[0]?.records).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(result.groups[1]?.records).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({ name: "top" }),
      }),
    );
  });

  it("keeps generated code-file enumeration deterministic", async () => {
    const files = 120;
    await mkdir(join(root, "src"), { recursive: true });
    for (let i = 0; i < files; i++) {
      const name = `mod${String(i).padStart(4, "0")}`;
      writeFileSync(
        join(root, "src", `${name}.ts`),
        `export function ${name}() { return ${i}; }\n`,
      );
    }

    const result = await buildCodeGraph(root);
    expect(result.filesScanned).toBe(files);
    expect(result.nodes).toBe(files);
  });

  it("skips tracked files that are deleted from the working tree", async () => {
    writeProjectFile(root, "src/live.ts", "export function live() { return 1; }\n");
    writeProjectFile(root, "src/deleted.ts", "export function deleted() { return 0; }\n");
    initGitRepo(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "init"]);
    rmSync(join(root, "src/deleted.ts"));

    const result = await buildCodeGraph(root);
    const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);

    expect(result.filesScanned).toBe(1);
    expect(nodesFile.nodes.map((node) => node.name)).toEqual(["live"]);
  });

  it("skips git-listed symlinked code files", async () => {
    const outsideRoot = `${root}-outside`;
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(
      join(outsideRoot, "secret.ts"),
      "export function externalSecret() { return 1; }\n",
    );
    writeProjectFile(root, "src/live.ts", "export function live() { return 1; }\n");
    mkdirSync(join(root, "src"), { recursive: true });
    let symlinksWorked = true;
    try {
      symlinkSync(join(outsideRoot, "secret.ts"), join(root, "src", "linked.ts"));
    } catch {
      symlinksWorked = false;
    }
    try {
      if (!symlinksWorked) return;
      initGitRepo(root);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "init"]);

      const result = await buildCodeGraph(root);
      const nodesFile = readJson<NodesFile>(codeGraphPaths(root).nodes);

      expect(result.filesScanned).toBe(1);
      expect(result.filesScanned).toBe(Object.keys(loadFileStamps(root)).length);
      expect(nodesFile.nodes.map((node) => node.name)).toEqual(["live"]);
    } finally {
      rmSync(outsideRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  // P0-1 regression: a build timeout must engage a per-root cooldown so the
  // next find_references doesn't relaunch the same doomed build (livelock).
  it("does not relaunch graph build inside the per-root cooldown window after a timeout", async () => {
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );

    const first = await findReferences(
      root,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraphBuildTimeoutMs: 0 },
    );
    const second = await findReferences(
      root,
      { symbol: "helper", relation: "callers", scope: "src" },
      { codeGraphBuildTimeoutMs: 0 },
    );

    expect(first.records).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    expect(second.records).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({ name: "run" }),
      }),
    );
    const stats = getCodeGraphStats();
    // Second call must skip the doomed build → buildTimeouts pinned at 1.
    expect(stats).toMatchObject({
      builds: 0,
      buildTimeouts: 1,
      queries: 2,
      fallbacks: 2,
    });
    expect(existsSync(codeGraphPaths(root).nodes)).toBe(false);
  });

  // P0-2 regression: incremental ≡ full when a new file lands that resolves an
  // older file's previously-unresolved reference.
  it("re-resolves dangling refs from old files when a new file adds the missing target", async () => {
    writeProjectFile(
      root,
      "src/b.ts",
      'import { helper } from "./a";\nexport function run() { return helper(); }\n',
    );

    // First build: a.ts does not exist yet → helper() ref is unresolved and
    // must be persisted in the graph for later re-resolution.
    const first = await buildCodeGraph(root);
    expect(first.unresolvedRefs).toBeGreaterThan(0);
    const beforeGraph = await loadCodeGraph(root);
    expect(
      beforeGraph?.unresolvedRefs.some((ref) => ref.targetName === "helper" && ref.kind === "call"),
    ).toBe(true);

    await waitForMtimeTick();
    writeProjectFile(root, "src/a.ts", "export function helper() { return 1; }\n");

    const incremental = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const incrementalRecord = incremental.records.find(
      (record) => record.file === "src/b.ts" && record.from?.name === "run",
    );
    expect(incrementalRecord).toBeDefined();

    // Cross-check against a clean full rebuild from the same final tree.
    rmSync(codeGraphPaths(root).dir, { recursive: true, force: true });
    await buildCodeGraph(root);
    const full = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });
    const fullRecord = full.records.find(
      (record) => record.file === "src/b.ts" && record.from?.name === "run",
    );
    expect(fullRecord).toBeDefined();
    // Caller record line/column/relation/symbol all match — incremental ≡ full.
    expect(incrementalRecord).toMatchObject({
      file: fullRecord?.file,
      line: fullRecord?.line,
      column: fullRecord?.column,
      relation: fullRecord?.relation,
      symbol: fullRecord?.symbol,
    });
  });

  // P0-3 regression: a function body containing `"}"` / `// }` no longer
  // truncates endLine, so a call below the literal still attributes to the
  // enclosing owner.
  it("does not truncate symbol endLine on bodies containing string or comment braces", async () => {
    writeProjectFile(
      root,
      "src/a.ts",
      [
        "export function helper() { return 1; }",
        "export function wrapper() {",
        '  const s = "}"; // }',
        "  return helper();",
        "}",
      ].join("\n"),
    );

    await buildCodeGraph(root);
    const callers = await findReferences(root, {
      symbol: "helper",
      relation: "callers",
      scope: "src",
    });

    // Owner must be `wrapper`, not undefined or the file-level scope. If
    // findBraceBlockEnd had been counting the `"}"` literal, wrapper.endLine
    // would stop at line 3 and the helper() call on line 4 would lose its
    // owner — the graph caller edge would silently disappear.
    expect(callers.records).toContainEqual(
      expect.objectContaining({
        file: "src/a.ts",
        line: 4,
        from: expect.objectContaining({ name: "wrapper" }),
      }),
    );
  });
});

import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { grammarForPath } from "../../code-query/parser.js";
import { loadCodeGraphIncludeBody } from "../../config.js";
import { Bm25Index } from "../lexical/bm25.js";
import { extractCodeGraphFile } from "./extractors.js";
import { resolveUnresolved } from "./resolver.js";
import { recordCodeGraphBuild, recordCodeGraphBuildTimeout } from "./stats.js";
import type {
  CodeGraphData,
  CodeGraphEdge,
  CodeGraphFileStamp,
  CodeGraphImport,
  CodeGraphNode,
  CodeGraphUnresolvedRef,
  InMemoryCodeGraph,
} from "./types.js";
import { type CodeGraphPaths, writeCodeGraph } from "./writer.js";

const execFileAsync = promisify(execFile);

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".gitnexus",
  ".maos",
  ".reasonix",
  "coverage",
  "dist",
  "node_modules",
  "sessions",
  "target",
]);
const CODE_GRAPH_FILE_CONCURRENCY = 128;

export interface BuildCodeGraphResult {
  root: string;
  filesScanned: number;
  nodes: number;
  edges: number;
  unresolvedRefs: number;
  elapsedMs: number;
  paths: CodeGraphPaths;
}

export interface BuildCodeGraphOptions {
  includeBody?: boolean;
  timeoutMs?: number;
}

export async function buildCodeGraph(
  root: string,
  opts: BuildCodeGraphOptions = {},
): Promise<BuildCodeGraphResult> {
  const started = performance.now();
  const absRoot = resolve(root);
  const includeBody = opts.includeBody ?? loadCodeGraphIncludeBody();
  assertBuildBudget(started, opts.timeoutMs);
  const files = await listCodeFiles(absRoot);
  const projectFiles = new Set(files.map((file) => rootRelativePath(absRoot, file)));
  assertBuildBudget(started, opts.timeoutMs);
  const nodes: CodeGraphNode[] = [];
  const extractedEdges: CodeGraphEdge[] = [];
  const unresolvedRefs: CodeGraphUnresolvedRef[] = [];
  const imports: CodeGraphImport[] = [];
  const fileStamps: Record<string, CodeGraphFileStamp> = {};
  const fileResults = await mapWithConcurrency(
    files,
    CODE_GRAPH_FILE_CONCURRENCY,
    async (absPath) => {
      const relPath = rootRelativePath(absRoot, absPath);
      const snapshot = await readCodeFileSnapshot(absPath);
      if (!snapshot) return null;
      const extracted = await extractCodeGraphFile(
        absRoot,
        absPath,
        relPath,
        snapshot.source,
        snapshot.stat,
        {},
        { includeBody, projectFiles },
      );
      assertBuildBudget(started, opts.timeoutMs);
      return { relPath, stat: snapshot.stat, extracted };
    },
  );
  let filesScanned = 0;
  for (const result of fileResults) {
    if (!result) continue;
    filesScanned += 1;
    fileStamps[result.relPath] = {
      mtimeMs: result.stat.mtimeMs,
      size: result.stat.size,
    };
    nodes.push(...result.extracted.nodes);
    extractedEdges.push(...result.extracted.edges);
    unresolvedRefs.push(...result.extracted.unresolvedRefs);
    imports.push(...result.extracted.imports);
  }

  const sortedNodes = sortNodes(nodes);
  const resolved = resolveUnresolved({
    nodes: sortedNodes,
    edges: extractedEdges,
    unresolvedRefs,
    imports,
  });
  const graph: CodeGraphData = {
    nodes: sortedNodes,
    edges: resolved.edges,
    // Persist remaining unresolved refs so later incremental updates can
    // re-resolve them when missing targets land (P0-2 fix).
    unresolvedRefs: resolved.remaining,
    imports,
    files: sortFileStamps(fileStamps),
    bm25: buildSymbolBm25(sortedNodes),
  };
  assertBuildBudget(started, opts.timeoutMs);
  const paths = await writeCodeGraph(absRoot, graph);
  const elapsedMs = Math.round(performance.now() - started);
  const artifactBytes = await totalArtifactBytes(paths);
  recordCodeGraphBuild({
    elapsedMs,
    nodes: sortedNodes.length,
    edges: resolved.edges.length,
    artifactBytes,
  });
  return {
    root: absRoot,
    filesScanned,
    nodes: sortedNodes.length,
    edges: resolved.edges.length,
    unresolvedRefs: resolved.remaining.length,
    elapsedMs,
    paths,
  };
}

export async function incrementalUpdate(
  root: string,
  graph: InMemoryCodeGraph,
  staleFiles: readonly string[],
  opts: BuildCodeGraphOptions = {},
): Promise<BuildCodeGraphResult> {
  const started = performance.now();
  const absRoot = resolve(root);
  const includeBody = opts.includeBody ?? loadCodeGraphIncludeBody();
  const staleSet = new Set(staleFiles.map(normalizeGraphPath).filter(Boolean));
  assertBuildBudget(started, opts.timeoutMs);
  const affectedFiles = affectedFilesForIncremental(graph, staleSet);
  const nodes = graph.nodes.filter((node) => !affectedFiles.has(node.file));
  const imports = graph.imports.filter((item) => !affectedFiles.has(item.file));
  const extractedEdges: CodeGraphEdge[] = [];
  const unresolvedRefs: CodeGraphUnresolvedRef[] = [];
  const fileStamps = { ...graph.files };
  let filesScanned = 0;

  for (const relPath of [...affectedFiles].sort((a, b) => a.localeCompare(b))) {
    const absPath = resolveGraphPath(absRoot, relPath);
    const snapshot = await readCodeFileSnapshot(absPath);
    if (!snapshot) {
      delete fileStamps[relPath];
      assertBuildBudget(started, opts.timeoutMs);
      continue;
    }
    filesScanned += 1;
    fileStamps[relPath] = {
      mtimeMs: snapshot.stat.mtimeMs,
      size: snapshot.stat.size,
    };
    const extracted = await extractCodeGraphFile(
      absRoot,
      absPath,
      relPath,
      snapshot.source,
      snapshot.stat,
      {},
      { includeBody },
    );
    nodes.push(...extracted.nodes);
    extractedEdges.push(...extracted.edges);
    unresolvedRefs.push(...extracted.unresolvedRefs);
    imports.push(...extracted.imports);
    assertBuildBudget(started, opts.timeoutMs);
  }

  const sortedNodes = sortNodes(nodes);
  const nodeIds = new Set(sortedNodes.map((node) => node.id));
  const preservedEdges = graph.edges.filter((edge) => {
    const source = graph.nodesById.get(edge.source);
    if (!source || affectedFiles.has(source.file)) return false;
    return edge.target.startsWith("?:") || nodeIds.has(edge.target);
  });
  // Re-resolve old unresolved refs from non-affected files too — a newly added
  // file can satisfy them now, which is exactly the case full rebuild handles
  // and pre-P0-2 incremental silently dropped.
  const preservedUnresolvedRefs = graph.unresolvedRefs.filter(
    (ref) => !affectedFiles.has(ref.file),
  );
  const resolved = resolveUnresolved({
    nodes: sortedNodes,
    edges: [...preservedEdges, ...extractedEdges],
    unresolvedRefs: [...preservedUnresolvedRefs, ...unresolvedRefs],
    imports,
  });
  const updatedGraph: CodeGraphData = {
    nodes: sortedNodes,
    edges: resolved.edges,
    unresolvedRefs: resolved.remaining,
    imports,
    files: sortFileStamps(fileStamps),
    bm25: buildSymbolBm25(sortedNodes),
  };
  assertBuildBudget(started, opts.timeoutMs);
  const paths = await writeCodeGraph(absRoot, updatedGraph);
  const elapsedMs = Math.round(performance.now() - started);
  const artifactBytes = await totalArtifactBytes(paths);
  recordCodeGraphBuild({
    elapsedMs,
    nodes: sortedNodes.length,
    edges: resolved.edges.length,
    artifactBytes,
  });
  return {
    root: absRoot,
    filesScanned,
    nodes: sortedNodes.length,
    edges: resolved.edges.length,
    unresolvedRefs: resolved.remaining.length,
    elapsedMs,
    paths,
  };
}

export class CodeGraphBuildTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`code graph build timed out after ${timeoutMs}ms`);
    this.name = "CodeGraphBuildTimeoutError";
  }
}

function assertBuildBudget(started: number, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  const elapsedMs = Math.round(performance.now() - started);
  if (timeoutMs > 0 && elapsedMs <= timeoutMs) return;
  recordCodeGraphBuildTimeout({ timeoutMs, elapsedMs });
  throw new CodeGraphBuildTimeoutError(timeoutMs);
}

async function totalArtifactBytes(paths: CodeGraphPaths): Promise<number> {
  const fileStats = await Promise.all([
    stat(paths.nodes),
    stat(paths.edges),
    stat(paths.bm25),
    stat(paths.filesStamps),
  ]);
  return fileStats.reduce((sum, item) => sum + item.size, 0);
}

async function readCodeFileSnapshot(
  absPath: string,
): Promise<{ source: string; stat: Stats } | null> {
  if (process.platform === "win32") {
    const fileStat = await lstat(absPath).catch((err: unknown) => {
      if (isTransientReadMiss(err)) return null;
      throw err;
    });
    if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) return null;
  }

  const handle = await openForReadNoFollow(absPath).catch((err: unknown) => {
    if (isTransientReadMiss(err)) return null;
    throw err;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    return { source: await handle.readFile("utf8"), stat };
  } finally {
    await handle.close();
  }
}

async function openForReadNoFollow(absPath: string) {
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  return await open(absPath, flags);
}

export async function listCodeFiles(root: string): Promise<string[]> {
  const gitFiles = await listGitFiles(root);
  if (gitFiles) return gitFiles;
  const files: string[] = [];
  await visitCodeFiles(root, files);
  return files.sort((a, b) => a.localeCompare(b));
}

async function listGitFiles(root: string): Promise<string[] | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 20 * 1024 * 1024 },
    );
    const candidates = result.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => resolve(root, file))
      .filter((file) => grammarForPath(file));
    const files = await mapWithConcurrency(
      candidates,
      CODE_GRAPH_FILE_CONCURRENCY,
      async (file) => {
        try {
          const fileStat = await lstat(file);
          return fileStat.isFile() ? file : null;
        } catch {}
        return null;
      },
    );
    return files.filter((file): file is string => file !== null).sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

async function visitCodeFiles(path: string, files: string[]): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (grammarForPath(path)) files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
    const next = resolve(path, entry.name);
    if (!existsSync(next)) continue;
    await visitCodeFiles(next, files);
  }
}

function buildSymbolBm25(nodes: readonly CodeGraphNode[]): Bm25Index {
  const index = new Bm25Index();
  for (const node of nodes) index.add(node.id, symbolTokens(node));
  return index;
}

function symbolTokens(node: CodeGraphNode): string[] {
  return `${node.name} ${node.qualifiedName}`
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap(splitIdentifier)
    .filter(Boolean);
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function sortNodes(nodes: readonly CodeGraphNode[]): CodeGraphNode[] {
  return [...nodes].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.qualifiedName.localeCompare(b.qualifiedName) ||
      a.id.localeCompare(b.id),
  );
}

function sortFileStamps(
  stamps: Record<string, CodeGraphFileStamp>,
): Record<string, CodeGraphFileStamp> {
  return Object.fromEntries(Object.entries(stamps).sort(([a], [b]) => a.localeCompare(b)));
}

function rootRelativePath(root: string, absPath: string): string {
  return relative(root, absPath).replaceAll("\\", "/");
}

function normalizeGraphPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function resolveGraphPath(root: string, relPath: string): string {
  const absPath = resolve(root, relPath);
  if (!isInsideRoot(root, absPath)) throw new Error(`path escapes project root: ${relPath}`);
  return absPath;
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

function affectedFilesForIncremental(
  graph: InMemoryCodeGraph,
  staleFiles: ReadonlySet<string>,
): Set<string> {
  const affected = new Set(staleFiles);
  for (const item of graph.imports) {
    if (item.resolvedPath && staleFiles.has(item.resolvedPath)) affected.add(item.file);
  }
  for (const edge of graph.edges) {
    const source = graph.nodesById.get(edge.source);
    const target = edge.target.startsWith("?:") ? undefined : graph.nodesById.get(edge.target);
    if (source && target && staleFiles.has(target.file)) affected.add(source.file);
  }
  return affected;
}

function isTransientReadMiss(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    ((err as NodeJS.ErrnoException).code === "ENOENT" ||
      (err as NodeJS.ErrnoException).code === "ENOTDIR" ||
      (err as NodeJS.ErrnoException).code === "ELOOP" ||
      (err as NodeJS.ErrnoException).code === "EPERM")
  );
}

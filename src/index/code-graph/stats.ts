import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Bm25Index } from "../lexical/bm25.js";
import {
  CODE_GRAPH_VERSION,
  type CodeGraphEdgeKind,
  type CodeGraphEdgeProvenance,
  type CodeGraphFileStamp,
  type CodeGraphImport,
  type CodeGraphImportBinding,
  type CodeGraphNodeKind,
} from "./types.js";
import { codeGraphPaths, hashGraphArtifacts } from "./writer.js";

export interface CodeGraphStats {
  builds: number;
  buildTimeouts: number;
  loads: number;
  cacheHits: number;
  queries: number;
  fallbacks: number;
  lastBuildElapsedMs?: number;
  lastBuildTimeoutMs?: number;
  lastNodes?: number;
  lastEdges?: number;
  lastArtifactBytes?: number;
  stalenessRatio?: number;
}

export interface CodeGraphArtifactStats {
  nodes: number;
  edges: number;
  files: number;
  artifactBytes: number;
  stalenessRatio: number;
}

let stats: CodeGraphStats = emptyStats();

export function resetCodeGraphStats(): void {
  stats = emptyStats();
}

export function getCodeGraphStats(): CodeGraphStats {
  return { ...stats };
}

export function recordCodeGraphBuild(input: {
  elapsedMs: number;
  nodes: number;
  edges: number;
  artifactBytes?: number;
}): void {
  stats.builds += 1;
  stats.lastBuildElapsedMs = input.elapsedMs;
  stats.lastNodes = input.nodes;
  stats.lastEdges = input.edges;
  if (input.artifactBytes !== undefined) stats.lastArtifactBytes = input.artifactBytes;
}

export function recordCodeGraphBuildTimeout(input: { timeoutMs: number; elapsedMs: number }): void {
  stats.buildTimeouts += 1;
  stats.lastBuildTimeoutMs = input.timeoutMs;
  stats.lastBuildElapsedMs = input.elapsedMs;
}

export function recordCodeGraphLoad(input: {
  cacheHit?: boolean;
  nodes?: number;
  edges?: number;
  artifactBytes?: number;
  stalenessRatio?: number;
}): void {
  stats.loads += 1;
  if (input.cacheHit) stats.cacheHits += 1;
  if (input.nodes !== undefined) stats.lastNodes = input.nodes;
  if (input.edges !== undefined) stats.lastEdges = input.edges;
  if (input.artifactBytes !== undefined) stats.lastArtifactBytes = input.artifactBytes;
  if (input.stalenessRatio !== undefined) stats.stalenessRatio = input.stalenessRatio;
}

export function recordCodeGraphQuery(
  input: {
    fallback?: boolean;
    nodes?: number;
    edges?: number;
    stalenessRatio?: number;
  } = {},
): void {
  stats.queries += 1;
  if (input.fallback) stats.fallbacks += 1;
  if (input.nodes !== undefined) stats.lastNodes = input.nodes;
  if (input.edges !== undefined) stats.lastEdges = input.edges;
  if (input.stalenessRatio !== undefined) stats.stalenessRatio = input.stalenessRatio;
}

export function recordCodeGraphStaleness(stalenessRatio: number): void {
  stats.stalenessRatio = stalenessRatio;
}

function emptyStats(): CodeGraphStats {
  return {
    builds: 0,
    buildTimeouts: 0,
    loads: 0,
    cacheHits: 0,
    queries: 0,
    fallbacks: 0,
  };
}

export async function readCodeGraphArtifactStats(
  root: string,
): Promise<CodeGraphArtifactStats | null> {
  const absRoot = resolve(root);
  const paths = codeGraphPaths(absRoot);
  let artifactBytes = 0;
  try {
    const fileStats = await Promise.all([
      lstat(paths.nodes),
      lstat(paths.edges),
      lstat(paths.bm25),
      lstat(paths.filesStamps),
    ]);
    if (fileStats.some((item) => !item.isFile())) {
      throw new Error("invalid code graph artifact file");
    }
    artifactBytes = fileStats.reduce((sum, item) => sum + item.size, 0);
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }

  const [nodesRaw, edgesRaw, bm25Raw, filesRaw] = await Promise.all([
    readFile(paths.nodes, "utf8"),
    readFile(paths.edges, "utf8"),
    readFile(paths.bm25, "utf8"),
    readFile(paths.filesStamps, "utf8"),
  ]);
  assertMatchingGraphHashes([
    graphHashPayload(nodesRaw, "nodes"),
    graphHashPayload(edgesRaw, "edges"),
    graphHashPayload(bm25Raw, "bm25"),
    graphHashPayload(filesRaw, "files"),
  ]);
  const nodes = parseNodesForStats(nodesRaw);
  const edges = parseEdgesForStats(edgesRaw, nodes.ids);
  Bm25Index.load(bm25Raw);
  const files = parseFileStamps(filesRaw);
  const stalenessRatio = await computeStalenessRatio(absRoot, files);
  return {
    nodes: nodes.count,
    edges,
    files: Object.keys(files).length,
    artifactBytes,
    stalenessRatio,
  };
}

const NODE_KIND_VALUES = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "method",
  "property",
  "namespace",
] satisfies readonly CodeGraphNodeKind[];
const EDGE_KIND_VALUES = [
  "call",
  "import",
  "extends",
  "implements",
  "contains",
] satisfies readonly CodeGraphEdgeKind[];
const EDGE_PROVENANCE_VALUES = [
  "extracted",
  "inferred",
  "ambiguous",
] satisfies readonly CodeGraphEdgeProvenance[];
const NODE_KINDS: ReadonlySet<string> = new Set(NODE_KIND_VALUES);
const EDGE_KINDS: ReadonlySet<string> = new Set(EDGE_KIND_VALUES);
const EDGE_PROVENANCES: ReadonlySet<string> = new Set(EDGE_PROVENANCE_VALUES);

function parseNodesForStats(raw: string): { count: number; ids: Set<string> } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph nodes");
  const value = parsed as { version?: unknown; nodes?: unknown };
  if (value.version !== CODE_GRAPH_VERSION || !Array.isArray(value.nodes)) {
    throw new Error("unsupported code graph nodes");
  }
  const ids = new Set<string>();
  for (const rawNode of value.nodes) {
    const node = parseStatsNode(rawNode);
    ids.add(node.id);
  }
  return { count: value.nodes.length, ids };
}

function parseStatsNode(raw: unknown): { id: string } {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph node");
  const node = raw as {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    qualifiedName?: unknown;
    file?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    exportKind?: unknown;
  };
  if (
    typeof node.id !== "string" ||
    typeof node.kind !== "string" ||
    typeof node.name !== "string" ||
    typeof node.qualifiedName !== "string" ||
    typeof node.file !== "string" ||
    typeof node.startLine !== "number" ||
    typeof node.endLine !== "number"
  ) {
    throw new Error("invalid code graph node fields");
  }
  if (!NODE_KINDS.has(node.kind)) throw new Error("invalid code graph node kind");
  if (!isPositiveFinite(node.startLine) || !isPositiveFinite(node.endLine)) {
    throw new Error("invalid code graph node location");
  }
  if (node.endLine < node.startLine) throw new Error("invalid code graph node range");
  if (node.exportKind !== undefined && node.exportKind !== "default") {
    throw new Error("invalid code graph node export kind");
  }
  return { id: node.id };
}

function parseEdgesForStats(raw: string, nodeIds: ReadonlySet<string>): number {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph edges");
  const value = parsed as { version?: unknown; edges?: unknown; imports?: unknown };
  if (value.version !== CODE_GRAPH_VERSION || !Array.isArray(value.edges)) {
    throw new Error("unsupported code graph edges");
  }
  if (value.imports !== undefined && !Array.isArray(value.imports)) {
    throw new Error("invalid code graph imports");
  }
  for (const rawEdge of value.edges) parseStatsEdge(rawEdge, nodeIds);
  for (const rawImport of value.imports ?? []) parseStatsImport(rawImport);
  return value.edges.length;
}

function parseStatsEdge(raw: unknown, nodeIds: ReadonlySet<string>): void {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph edge");
  const edge = raw as {
    source?: unknown;
    target?: unknown;
    kind?: unknown;
    line?: unknown;
    col?: unknown;
    provenance?: unknown;
    candidates?: unknown;
  };
  if (
    typeof edge.source !== "string" ||
    typeof edge.target !== "string" ||
    typeof edge.kind !== "string" ||
    typeof edge.line !== "number" ||
    typeof edge.col !== "number" ||
    typeof edge.provenance !== "string"
  ) {
    throw new Error("invalid code graph edge fields");
  }
  if (!EDGE_KINDS.has(edge.kind)) throw new Error("invalid code graph edge kind");
  if (!EDGE_PROVENANCES.has(edge.provenance)) {
    throw new Error("invalid code graph edge provenance");
  }
  if (!isPositiveFinite(edge.line) || !isPositiveFinite(edge.col)) {
    throw new Error("invalid code graph edge location");
  }
  if (edge.candidates !== undefined && !isStringArray(edge.candidates)) {
    throw new Error("invalid code graph edge candidates");
  }
  if (!nodeIds.has(edge.source)) throw new Error("dangling code graph edge source");
  if (!edge.target.startsWith("?:") && !nodeIds.has(edge.target)) {
    throw new Error("dangling code graph edge target");
  }
}

function parseStatsImport(raw: unknown): void {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph import");
  const item = raw as Partial<CodeGraphImport>;
  if (
    typeof item.file !== "string" ||
    typeof item.line !== "number" ||
    typeof item.col !== "number" ||
    typeof item.source !== "string" ||
    typeof item.kind !== "string" ||
    !Array.isArray(item.names) ||
    !Array.isArray(item.bindings) ||
    typeof item.raw !== "string"
  ) {
    throw new Error("invalid code graph import fields");
  }
  if (item.kind !== "import" && item.kind !== "export") {
    throw new Error("invalid code graph import kind");
  }
  if (!isPositiveFinite(item.line) || !isPositiveFinite(item.col)) {
    throw new Error("invalid code graph import location");
  }
  if (!isStringArray(item.names)) throw new Error("invalid code graph import names");
  if (item.resolvedPath !== undefined && typeof item.resolvedPath !== "string") {
    throw new Error("invalid code graph import path");
  }
  for (const binding of item.bindings) parseStatsImportBinding(binding);
}

function parseStatsImportBinding(raw: unknown): void {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph import binding");
  const binding = raw as Partial<CodeGraphImportBinding>;
  if (
    typeof binding.importedName !== "string" ||
    typeof binding.localName !== "string" ||
    typeof binding.kind !== "string"
  ) {
    throw new Error("invalid code graph import binding fields");
  }
  if (binding.kind !== "default" && binding.kind !== "named" && binding.kind !== "namespace") {
    throw new Error("invalid code graph import binding kind");
  }
  if (binding.typeOnly !== undefined && typeof binding.typeOnly !== "boolean") {
    throw new Error("invalid code graph import binding type");
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

interface GraphHashPayload {
  graphHash: string;
  payload: string;
}

function graphHashPayload(
  raw: string,
  key: "nodes" | "edges" | "bm25" | "files",
): GraphHashPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid code graph ${key}`);
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.graphHash !== "string" || value.graphHash.length === 0) {
    throw new Error(`missing code graph ${key} hash`);
  }
  const payload = Object.fromEntries(
    Object.entries(value).filter(([entryKey]) => entryKey !== "graphHash"),
  );
  return { graphHash: value.graphHash, payload: JSON.stringify(payload) };
}

function assertMatchingGraphHashes(parts: readonly GraphHashPayload[]): void {
  const first = parts[0]?.graphHash;
  if (!first || parts.some((part) => part.graphHash !== first)) {
    throw new Error("mismatched code graph artifacts");
  }
  if (hashGraphArtifacts(parts.map((part) => part.payload)) !== first) {
    throw new Error("invalid code graph artifact hash");
  }
}

function parseFileStamps(raw: string): Record<string, CodeGraphFileStamp> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph file stamps");
  const value = parsed as { version?: unknown; files?: unknown };
  if (value.version !== CODE_GRAPH_VERSION || !value.files || typeof value.files !== "object") {
    throw new Error("unsupported code graph file stamps");
  }
  const out: Record<string, CodeGraphFileStamp> = {};
  for (const [path, stamp] of Object.entries(value.files)) {
    if (!stamp || typeof stamp !== "object") throw new Error("invalid code graph file stamp");
    const item = stamp as { mtimeMs?: unknown; size?: unknown };
    if (
      typeof item.mtimeMs !== "number" ||
      typeof item.size !== "number" ||
      !Number.isFinite(item.mtimeMs) ||
      !Number.isFinite(item.size) ||
      item.mtimeMs < 0 ||
      item.size < 0
    ) {
      throw new Error("invalid code graph file stamp fields");
    }
    out[path] = { mtimeMs: item.mtimeMs, size: item.size };
  }
  return out;
}

async function computeStalenessRatio(
  root: string,
  files: Record<string, CodeGraphFileStamp>,
): Promise<number> {
  const entries = Object.entries(files);
  if (entries.length === 0) return 0;
  let stale = 0;
  for (const [path, stamp] of entries) {
    const target = resolve(root, path);
    if (!isInsideRoot(root, target)) {
      stale += 1;
      continue;
    }
    try {
      const current = await lstat(target);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.size !== stamp.size ||
        Math.abs(current.mtimeMs - stamp.mtimeMs) > 1
      ) {
        stale += 1;
      }
    } catch {
      stale += 1;
    }
  }
  return stale / entries.length;
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isMissingFile(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    ((err as NodeJS.ErrnoException).code === "ENOENT" ||
      (err as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

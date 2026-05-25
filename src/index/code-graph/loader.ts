import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCodeGraphEnabled } from "../../config.js";
import { Bm25Index } from "../lexical/bm25.js";
import { recordCodeGraphLoad } from "./stats.js";
import {
  CODE_GRAPH_VERSION,
  type CodeGraphEdge,
  type CodeGraphEdgeKind,
  type CodeGraphEdgeProvenance,
  type CodeGraphFileStamp,
  type CodeGraphImport,
  type CodeGraphImportBinding,
  type CodeGraphNode,
  type CodeGraphNodeKind,
  type CodeGraphUnresolvedRef,
  type InMemoryCodeGraph,
} from "./types.js";
import { codeGraphPaths, hashGraphArtifacts } from "./writer.js";

interface GraphCacheEntry {
  signature: string;
  graph: InMemoryCodeGraph;
}

const graphCache = new Map<string, GraphCacheEntry>();
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

export async function loadCodeGraph(root: string): Promise<InMemoryCodeGraph | null> {
  if (!loadCodeGraphEnabled()) return null;
  const absRoot = resolve(root);
  const paths = codeGraphPaths(absRoot);
  const signature = await graphSignature([paths.nodes, paths.edges, paths.bm25, paths.filesStamps]);
  if (!signature) return null;
  const cached = graphCache.get(absRoot);
  if (cached?.signature === signature.value) {
    recordCodeGraphLoad({
      cacheHit: true,
      nodes: cached.graph.nodes.length,
      edges: cached.graph.edges.length,
      artifactBytes: signature.bytes,
    });
    return cached.graph;
  }
  let nodesRaw: string;
  let edgesRaw: string;
  let bm25Raw: string;
  let filesRaw: string;
  try {
    [nodesRaw, edgesRaw, bm25Raw, filesRaw] = await Promise.all([
      readFile(paths.nodes, "utf8"),
      readFile(paths.edges, "utf8"),
      readFile(paths.bm25, "utf8"),
      readFile(paths.filesStamps, "utf8"),
    ]);
  } catch (err) {
    if (isMissingFile(err)) {
      graphCache.delete(absRoot);
      return null;
    }
    throw err;
  }

  assertMatchingGraphHashes([
    graphHashPayload(nodesRaw, "nodes"),
    graphHashPayload(edgesRaw, "edges"),
    graphHashPayload(bm25Raw, "bm25"),
    graphHashPayload(filesRaw, "files"),
  ]);
  const nodes = parseNodes(nodesRaw);
  const edgePayload = parseEdges(edgesRaw);
  const files = parseFiles(filesRaw);
  const nodesById = mapById(nodes);
  assertEdgesReferenceNodes(edgePayload.edges, nodesById);
  const graph = {
    root: absRoot,
    nodes,
    edges: edgePayload.edges,
    unresolvedRefs: edgePayload.unresolvedRefs,
    imports: edgePayload.imports,
    files,
    nodesById,
    nodesByName: groupBy(nodes, (node) => node.name),
    edgesBySource: groupBy(edgePayload.edges, (edge) => edge.source),
    edgesByTarget: groupBy(edgePayload.edges, (edge) => edge.target),
    bm25: Bm25Index.load(bm25Raw),
  };
  graphCache.set(absRoot, { signature: signature.value, graph });
  recordCodeGraphLoad({
    nodes: nodes.length,
    edges: edgePayload.edges.length,
    artifactBytes: signature.bytes,
  });
  return graph;
}

async function graphSignature(
  files: readonly string[],
): Promise<{ value: string; bytes: number } | null> {
  const parts: string[] = [];
  let bytes = 0;
  for (const file of files) {
    try {
      const s = await lstat(file);
      if (!s.isFile()) throw new Error("invalid code graph artifact file");
      parts.push(`${file}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`);
      bytes += s.size;
    } catch (err) {
      if (isMissingFile(err)) return null;
      throw err;
    }
  }
  return { value: parts.join("|"), bytes };
}

function parseNodes(raw: string): CodeGraphNode[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph nodes");
  const value = parsed as { version?: unknown; nodes?: unknown };
  if (value.version !== CODE_GRAPH_VERSION || !Array.isArray(value.nodes)) {
    throw new Error("unsupported code graph nodes");
  }
  return value.nodes.map(parseNode);
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

function parseEdges(raw: string): {
  edges: CodeGraphEdge[];
  imports: CodeGraphImport[];
  unresolvedRefs: CodeGraphUnresolvedRef[];
} {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph edges");
  const value = parsed as {
    version?: unknown;
    edges?: unknown;
    imports?: unknown;
    unresolvedRefs?: unknown;
  };
  if (value.version !== CODE_GRAPH_VERSION || !Array.isArray(value.edges)) {
    throw new Error("unsupported code graph edges");
  }
  if (value.imports !== undefined && !Array.isArray(value.imports)) {
    throw new Error("invalid code graph imports");
  }
  if (value.unresolvedRefs !== undefined && !Array.isArray(value.unresolvedRefs)) {
    throw new Error("invalid code graph unresolvedRefs");
  }
  return {
    edges: value.edges.map(parseEdge),
    imports: (value.imports ?? []).map(parseImport),
    // Older artifacts (pre-P0-2) had no unresolvedRefs field; treat as []
    // so a partial migration still loads, just without re-resolve potential.
    unresolvedRefs: (value.unresolvedRefs ?? []).map(parseUnresolvedRef),
  };
}

function parseUnresolvedRef(raw: unknown): CodeGraphUnresolvedRef {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph unresolved ref");
  const ref = raw as Partial<CodeGraphUnresolvedRef>;
  if (
    typeof ref.source !== "string" ||
    typeof ref.targetName !== "string" ||
    typeof ref.kind !== "string" ||
    typeof ref.file !== "string" ||
    typeof ref.line !== "number" ||
    typeof ref.col !== "number"
  ) {
    throw new Error("invalid code graph unresolved ref fields");
  }
  if (
    ref.kind !== "call" &&
    ref.kind !== "import" &&
    ref.kind !== "extends" &&
    ref.kind !== "implements"
  ) {
    throw new Error("invalid code graph unresolved ref kind");
  }
  if (!isPositiveFiniteLine(ref.line) || !isPositiveFiniteLine(ref.col)) {
    throw new Error("invalid code graph unresolved ref location");
  }
  if (ref.receiverName !== undefined && typeof ref.receiverName !== "string") {
    throw new Error("invalid code graph unresolved ref receiverName");
  }
  if (ref.importSource !== undefined && typeof ref.importSource !== "string") {
    throw new Error("invalid code graph unresolved ref importSource");
  }
  return {
    source: ref.source,
    targetName: ref.targetName,
    kind: ref.kind,
    file: ref.file,
    line: ref.line,
    col: ref.col,
    ...(ref.receiverName ? { receiverName: ref.receiverName } : {}),
    ...(ref.importSource ? { importSource: ref.importSource } : {}),
  };
}

function parseFiles(raw: string): Record<string, CodeGraphFileStamp> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid code graph files");
  const value = parsed as { version?: unknown; files?: unknown };
  if (value.version !== CODE_GRAPH_VERSION || !value.files || typeof value.files !== "object") {
    throw new Error("unsupported code graph files");
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

function parseNode(raw: unknown): CodeGraphNode {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph node");
  const node = raw as Partial<CodeGraphNode>;
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
  if (!isNodeKind(node.kind)) throw new Error("invalid code graph node kind");
  if (!isPositiveFiniteLine(node.startLine) || !isPositiveFiniteLine(node.endLine)) {
    throw new Error("invalid code graph node location");
  }
  if (node.endLine < node.startLine) throw new Error("invalid code graph node range");
  if (node.exportKind !== undefined && node.exportKind !== "default") {
    throw new Error("invalid code graph node export kind");
  }
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    file: node.file,
    startLine: node.startLine,
    endLine: node.endLine,
    ...(node.exportKind === "default" ? { exportKind: node.exportKind } : {}),
    ...(typeof node.signature === "string" ? { signature: node.signature } : {}),
    ...(typeof node.docstring === "string" ? { docstring: node.docstring } : {}),
  };
}

function parseEdge(raw: unknown): CodeGraphEdge {
  if (!raw || typeof raw !== "object") throw new Error("invalid code graph edge");
  const edge = raw as Partial<CodeGraphEdge>;
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
  if (!isEdgeKind(edge.kind)) throw new Error("invalid code graph edge kind");
  if (!isEdgeProvenance(edge.provenance)) {
    throw new Error("invalid code graph edge provenance");
  }
  if (!isPositiveFiniteLine(edge.line) || !isPositiveFiniteLine(edge.col)) {
    throw new Error("invalid code graph edge location");
  }
  if (edge.candidates !== undefined && !isStringArray(edge.candidates)) {
    throw new Error("invalid code graph edge candidates");
  }
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    col: edge.col,
    provenance: edge.provenance,
    ...(edge.candidates ? { candidates: edge.candidates } : {}),
  };
}

function parseImport(raw: unknown): CodeGraphImport {
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
  if (!isPositiveFiniteLine(item.line) || !isPositiveFiniteLine(item.col)) {
    throw new Error("invalid code graph import location");
  }
  if (!isStringArray(item.names)) throw new Error("invalid code graph import names");
  if (item.resolvedPath !== undefined && typeof item.resolvedPath !== "string") {
    throw new Error("invalid code graph import path");
  }
  return {
    file: item.file,
    line: item.line,
    col: item.col,
    source: item.source,
    kind: item.kind,
    names: item.names,
    bindings: item.bindings.map(parseImportBinding),
    raw: item.raw,
    ...(item.resolvedPath ? { resolvedPath: item.resolvedPath } : {}),
  };
}

function parseImportBinding(raw: unknown): CodeGraphImportBinding {
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
  return {
    importedName: binding.importedName,
    localName: binding.localName,
    kind: binding.kind,
    ...(binding.typeOnly === true ? { typeOnly: true } : {}),
  };
}

function isNodeKind(value: string): value is CodeGraphNodeKind {
  return NODE_KINDS.has(value);
}

function isEdgeKind(value: string): value is CodeGraphEdgeKind {
  return EDGE_KINDS.has(value);
}

function isEdgeProvenance(value: string): value is CodeGraphEdgeProvenance {
  return EDGE_PROVENANCES.has(value);
}

function isPositiveFiniteLine(value: number): boolean {
  return Number.isFinite(value) && value >= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertEdgesReferenceNodes(
  edges: readonly CodeGraphEdge[],
  nodesById: ReadonlyMap<string, CodeGraphNode>,
): void {
  for (const edge of edges) {
    if (!nodesById.has(edge.source)) throw new Error("dangling code graph edge source");
    if (!edge.target.startsWith("?:") && !nodesById.has(edge.target)) {
      throw new Error("dangling code graph edge target");
    }
  }
}

function mapById(nodes: readonly CodeGraphNode[]): Map<string, CodeGraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

function isMissingFile(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    ((err as NodeJS.ErrnoException).code === "ENOENT" ||
      (err as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

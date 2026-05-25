import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODE_GRAPH_VERSION,
  type CodeGraphData,
  type CodeGraphEdge,
  type CodeGraphImport,
  type CodeGraphUnresolvedRef,
} from "./types.js";

export const CODE_GRAPH_INDEX_DIR = path.join(".reasonix", "index", "code-graph");
export const CODE_GRAPH_NODES_FILE = "nodes.json";
export const CODE_GRAPH_EDGES_FILE = "edges.json";
export const CODE_GRAPH_BM25_FILE = "bm25.json";
export const CODE_GRAPH_FILES_STAMPS_FILE = "files-stamps.json";

let atomicWriteCounter = 0;

export interface CodeGraphPaths {
  dir: string;
  nodes: string;
  edges: string;
  bm25: string;
  filesStamps: string;
}

export function codeGraphPaths(root: string): CodeGraphPaths {
  const dir = path.join(root, CODE_GRAPH_INDEX_DIR);
  return {
    dir,
    nodes: path.join(dir, CODE_GRAPH_NODES_FILE),
    edges: path.join(dir, CODE_GRAPH_EDGES_FILE),
    bm25: path.join(dir, CODE_GRAPH_BM25_FILE),
    filesStamps: path.join(dir, CODE_GRAPH_FILES_STAMPS_FILE),
  };
}

export async function writeCodeGraph(root: string, graph: CodeGraphData): Promise<CodeGraphPaths> {
  const paths = codeGraphPaths(root);
  const nodesRaw = serializeNodes(graph);
  const edgesRaw = serializeEdges(graph);
  const bm25Raw = graph.bm25.serialize();
  const filesRaw = serializeFileStamps(graph);
  const graphHash = hashGraphArtifacts([nodesRaw, edgesRaw, bm25Raw, filesRaw]);
  await mkdir(paths.dir, { recursive: true });
  await Promise.all([
    atomicWrite(paths.nodes, withGraphHash(nodesRaw, graphHash)),
    atomicWrite(paths.edges, withGraphHash(edgesRaw, graphHash)),
    atomicWrite(paths.bm25, withGraphHash(bm25Raw, graphHash)),
    atomicWrite(paths.filesStamps, withGraphHash(filesRaw, graphHash)),
  ]);
  return paths;
}

function serializeNodes(graph: CodeGraphData): string {
  const nodes = [...graph.nodes].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.qualifiedName.localeCompare(b.qualifiedName) ||
      a.id.localeCompare(b.id),
  );
  return JSON.stringify({ version: CODE_GRAPH_VERSION, nodes });
}

function serializeEdges(graph: CodeGraphData): string {
  return JSON.stringify({
    version: CODE_GRAPH_VERSION,
    edges: sortEdges(graph.edges),
    imports: sortImports(graph.imports),
    unresolvedRefs: sortUnresolvedRefs(graph.unresolvedRefs),
  });
}

export function sortUnresolvedRefs(
  refs: readonly CodeGraphUnresolvedRef[],
): CodeGraphUnresolvedRef[] {
  return [...refs].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.kind.localeCompare(b.kind) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.col - b.col ||
      a.targetName.localeCompare(b.targetName),
  );
}

export function sortEdges(edges: readonly CodeGraphEdge[]): CodeGraphEdge[] {
  return [...edges].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.kind.localeCompare(b.kind) ||
      a.target.localeCompare(b.target) ||
      a.line - b.line ||
      a.col - b.col,
  );
}

function sortImports(imports: readonly CodeGraphImport[]): CodeGraphImport[] {
  return [...imports].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.col - b.col ||
      a.source.localeCompare(b.source) ||
      a.kind.localeCompare(b.kind) ||
      a.raw.localeCompare(b.raw),
  );
}

function serializeFileStamps(graph: CodeGraphData): string {
  const files = Object.fromEntries(
    Object.entries(graph.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ version: CODE_GRAPH_VERSION, files });
}

export function hashGraphArtifacts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function withGraphHash(raw: string, graphHash: string): string {
  // P1-E: round-trip through parse/spread instead of `raw.slice(0,-1)` string
  // surgery so future serializers that emit arrays / pretty JSON / different
  // outer shapes don't silently emit broken artifacts. Object spread keeps
  // graphHash as the trailing key, matching the prior on-disk byte layout so
  // loader hash recomputation (Object.fromEntries strip + JSON.stringify) stays
  // byte-equivalent.
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("code graph artifact must be a JSON object before hashing");
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), graphHash });
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  atomicWriteCounter += 1;
  const tmp = `${target}.${process.pid}.${Date.now()}.${atomicWriteCounter}.tmp`;
  try {
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

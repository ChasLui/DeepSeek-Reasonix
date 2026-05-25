import type { SymbolKind } from "../../code-query/symbols.js";
import type { Bm25Index } from "../lexical/bm25.js";

export const CODE_GRAPH_VERSION = 1;

export type CodeGraphNodeKind = SymbolKind;
export type CodeGraphEdgeKind = "call" | "import" | "extends" | "implements" | "contains";
export type CodeGraphEdgeProvenance = "extracted" | "inferred" | "ambiguous";

export interface CodeGraphNode {
  id: string;
  kind: CodeGraphNodeKind;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  exportKind?: "default";
  signature?: string;
  docstring?: string;
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  kind: CodeGraphEdgeKind;
  line: number;
  col: number;
  provenance: CodeGraphEdgeProvenance;
  candidates?: string[];
}

export interface CodeGraphFileStamp {
  mtimeMs: number;
  size: number;
}

export interface CodeGraphImportBinding {
  importedName: string;
  localName: string;
  kind: "default" | "named" | "namespace";
  typeOnly?: boolean;
}

export interface CodeGraphImport {
  file: string;
  line: number;
  col: number;
  source: string;
  kind: "import" | "export";
  names: string[];
  bindings: CodeGraphImportBinding[];
  raw: string;
  resolvedPath?: string;
}

export interface CodeGraphUnresolvedRef {
  source: string;
  targetName: string;
  kind: Exclude<CodeGraphEdgeKind, "contains">;
  file: string;
  line: number;
  col: number;
  receiverName?: string;
  importSource?: string;
}

export interface CodeGraphData {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  unresolvedRefs: CodeGraphUnresolvedRef[];
  imports: CodeGraphImport[];
  files: Record<string, CodeGraphFileStamp>;
  bm25: Bm25Index;
}

export interface InMemoryCodeGraph {
  root: string;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  /** Refs the resolver could not bind to a node at write time. Kept so
   * incremental updates can re-resolve them when new project files appear,
   * preserving incremental ≡ full-rebuild equivalence. */
  unresolvedRefs: CodeGraphUnresolvedRef[];
  imports: CodeGraphImport[];
  files: Record<string, CodeGraphFileStamp>;
  nodesById: Map<string, CodeGraphNode>;
  nodesByName: Map<string, CodeGraphNode[]>;
  edgesBySource: Map<string, CodeGraphEdge[]>;
  edgesByTarget: Map<string, CodeGraphEdge[]>;
  bm25: Bm25Index;
}

export interface SerializedCodeGraphNodes {
  version: typeof CODE_GRAPH_VERSION;
  graphHash: string;
  nodes: CodeGraphNode[];
}

export interface SerializedCodeGraphEdges {
  version: typeof CODE_GRAPH_VERSION;
  graphHash: string;
  edges: CodeGraphEdge[];
  imports: CodeGraphImport[];
  /** Persisted so incremental updates can re-resolve when new files arrive. */
  unresolvedRefs?: CodeGraphUnresolvedRef[];
}

export interface SerializedCodeGraphFileStamps {
  version: typeof CODE_GRAPH_VERSION;
  graphHash: string;
  files: Record<string, CodeGraphFileStamp>;
}

import type {
  CodeGraphEdge,
  CodeGraphEdgeProvenance,
  CodeGraphImport,
  CodeGraphNode,
  CodeGraphUnresolvedRef,
} from "./types.js";
import { sortEdges, sortUnresolvedRefs } from "./writer.js";

export interface ResolveUnresolvedInput {
  nodes: readonly CodeGraphNode[];
  edges: readonly CodeGraphEdge[];
  unresolvedRefs: readonly CodeGraphUnresolvedRef[];
  imports: readonly CodeGraphImport[];
}

export interface ResolveUnresolvedResult {
  edges: CodeGraphEdge[];
  /** Refs the resolver could not bind to a node this round. Persist so a later
   * incremental update can re-resolve them once new files appear, keeping
   * incremental ≡ full-rebuild equivalence (P0-2 fix). */
  remaining: CodeGraphUnresolvedRef[];
}

export function resolveUnresolved(input: ResolveUnresolvedInput): ResolveUnresolvedResult {
  const resolver = new GraphResolver(input.nodes, input.imports);
  const resolved: CodeGraphEdge[] = [];
  const remaining: CodeGraphUnresolvedRef[] = [];
  for (const ref of input.unresolvedRefs) {
    const edge = resolver.resolve(ref);
    if (edge) resolved.push(edge);
    else remaining.push(ref);
  }
  return {
    edges: sortEdges(dedupeEdges([...input.edges, ...resolved])),
    remaining: sortUnresolvedRefs(remaining),
  };
}

class GraphResolver {
  private readonly nodesByName = new Map<string, CodeGraphNode[]>();
  private readonly nodesByFileName = new Map<string, CodeGraphNode[]>();
  private readonly defaultNodesByFile = new Map<string, CodeGraphNode[]>();
  private readonly importBindingsByLocal = new Map<string, ImportBindingEntry[]>();
  private readonly namespaceImportsByLocal = new Map<string, ImportBindingEntry[]>();

  constructor(nodes: readonly CodeGraphNode[], imports: readonly CodeGraphImport[]) {
    for (const node of nodes) {
      pushMapList(this.nodesByName, node.name, node);
      pushMapList(this.nodesByFileName, fileNameKey(node.file, node.name), node);
      if (node.exportKind === "default") pushMapList(this.defaultNodesByFile, node.file, node);
    }
    for (const item of imports) {
      if (item.kind !== "import" || !item.resolvedPath) continue;
      for (const binding of item.bindings) {
        const map =
          binding.kind === "namespace" ? this.namespaceImportsByLocal : this.importBindingsByLocal;
        pushMapList(map, fileNameKey(item.file, binding.localName), {
          item,
          binding,
        });
      }
    }
    for (const list of [...this.nodesByName.values(), ...this.nodesByFileName.values()]) {
      list.sort(
        (a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName),
      );
    }
  }

  resolve(ref: CodeGraphUnresolvedRef): CodeGraphEdge | null {
    if (ref.receiverName && ref.receiverName !== "this" && ref.receiverName !== "super") {
      const imported = this.resolveImported(ref);
      if (imported) return imported;
    }

    const sameFile = this.resolveSameFile(ref);
    if (sameFile) return sameFile;

    const imported = this.resolveImported(ref);
    if (imported) return imported;
    if (this.hasScopedImportBinding(ref)) return null;

    const global = this.nodesByName.get(ref.targetName) ?? [];
    const onlyGlobal = global[0];
    if (global.length === 1 && onlyGlobal) {
      return edge(ref, onlyGlobal.id, "ambiguous", [onlyGlobal.id]);
    }
    if (global.length > 1) {
      return edge(
        ref,
        `?:${ref.targetName}`,
        "ambiguous",
        global.slice(0, 8).map((candidate) => candidate.id),
      );
    }
    return null;
  }

  private resolveSameFile(ref: CodeGraphUnresolvedRef): CodeGraphEdge | null {
    return edgeForCandidates(
      ref,
      this.nodesByFileName.get(fileNameKey(ref.file, ref.targetName)),
      "extracted",
    );
  }

  private resolveImported(ref: CodeGraphUnresolvedRef): CodeGraphEdge | null {
    const entries = ref.receiverName
      ? (this.namespaceImportsByLocal.get(fileNameKey(ref.file, ref.receiverName)) ?? [])
      : (this.importBindingsByLocal.get(fileNameKey(ref.file, ref.targetName)) ?? []);
    for (const { item, binding } of entries) {
      if (ref.importSource && item.source !== ref.importSource) continue;
      if (ref.kind === "call" && binding.typeOnly) continue;
      const resolvedPath = item.resolvedPath;
      if (!resolvedPath) continue;
      const candidates = isDefaultImportBinding(binding)
        ? this.defaultNodesByFile.get(resolvedPath)
        : this.nodesByFileName.get(
            fileNameKey(
              resolvedPath,
              binding.kind === "namespace" ? ref.targetName : binding.importedName,
            ),
          );
      const target = edgeForCandidates(ref, candidates, "inferred");
      if (target) return target;
    }
    return null;
  }

  private hasScopedImportBinding(ref: CodeGraphUnresolvedRef): boolean {
    const entries = ref.receiverName
      ? this.namespaceImportsByLocal.get(fileNameKey(ref.file, ref.receiverName))
      : this.importBindingsByLocal.get(fileNameKey(ref.file, ref.targetName));
    return entries !== undefined && entries.length > 0;
  }
}

interface ImportBindingEntry {
  item: CodeGraphImport;
  binding: CodeGraphImport["bindings"][number];
}

function isDefaultImportBinding(binding: CodeGraphImport["bindings"][number]): boolean {
  return binding.kind === "default" || binding.importedName === "default";
}

function edgeForCandidates(
  ref: CodeGraphUnresolvedRef,
  candidates: readonly CodeGraphNode[] | undefined,
  provenance: CodeGraphEdgeProvenance,
): CodeGraphEdge | null {
  if (!candidates || candidates.length === 0) return null;
  const only = candidates[0];
  if (candidates.length === 1 && only) return edge(ref, only.id, provenance);
  return edge(
    ref,
    `?:${ref.targetName}`,
    "ambiguous",
    candidates.slice(0, 8).map((candidate) => candidate.id),
  );
}

function edge(
  ref: CodeGraphUnresolvedRef,
  target: string,
  provenance: CodeGraphEdgeProvenance,
  candidates?: string[],
): CodeGraphEdge {
  return {
    source: ref.source,
    target,
    kind: ref.kind,
    line: ref.line,
    col: ref.col,
    provenance,
    ...(candidates && candidates.length > 0 ? { candidates: [...candidates].sort() } : {}),
  };
}

function pushMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function fileNameKey(file: string, name: string): string {
  return `${file}\0${name}`;
}

function dedupeEdges(edges: readonly CodeGraphEdge[]): CodeGraphEdge[] {
  const seen = new Set<string>();
  const out: CodeGraphEdge[] = [];
  for (const item of edges) {
    const key = [item.source, item.target, item.kind, item.line, item.col].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

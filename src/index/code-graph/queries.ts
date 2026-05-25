import { isAbsolute, relative, resolve } from "node:path";
import type {
  CodeRelationRecord,
  ConfidenceTier,
  FindReferencesArgs,
  FindReferencesResult,
  SymbolRef,
} from "../../code-query/relations.js";
import type {
  CodeGraphEdge,
  CodeGraphEdgeProvenance,
  CodeGraphImport,
  CodeGraphNode,
  InMemoryCodeGraph,
} from "./types.js";

const confidenceScore = {
  EXTRACTED: 0.95,
  INFERRED: 0.9,
  AMBIGUOUS: 0.5,
} satisfies Record<ConfidenceTier, number>;

export function findReferencesInGraph(
  graph: InMemoryCodeGraph,
  args: FindReferencesArgs,
): FindReferencesResult | null {
  const symbol = args.symbol.trim();
  const scope = args.scope?.trim() || ".";
  const records = relationRecords(graph, args.relation, symbol, scope);
  return {
    symbol,
    relation: args.relation,
    scope,
    bestEffort: true,
    candidatesScanned: filesInScope(graph, scope).size,
    truncated: false,
    records: sortRecords(dedupeRecords(records)),
  };
}

function relationRecords(
  graph: InMemoryCodeGraph,
  relation: FindReferencesArgs["relation"],
  symbol: string,
  scope: string,
): CodeRelationRecord[] {
  if (relation === "callers") return callerRecords(graph, symbol, scope);
  if (relation === "callees") return calleeRecords(graph, symbol, scope);
  if (relation === "imports") return importsRecords(graph, symbol, scope);
  return importerRecords(graph, symbol, scope);
}

function callerRecords(
  graph: InMemoryCodeGraph,
  symbol: string,
  scope: string,
): CodeRelationRecord[] {
  const targets = matchingNodes(graph, symbol);
  const targetIds = new Set(targets.map((node) => node.id));
  const records: CodeRelationRecord[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "call") continue;
    if (!targetIds.has(edge.target) && edge.target !== `?:${symbol}`) continue;
    const source = graph.nodesById.get(edge.source);
    if (!source || !pathInScope(graph, source.file, scope)) continue;
    const target = graph.nodesById.get(edge.target);
    records.push({
      file: source.file,
      line: edge.line,
      column: edge.col,
      relation: "callers",
      symbol,
      ...confidenceFields(edge.provenance),
      from: symbolRef(source),
      ...(target ? { to: symbolRef(target) } : {}),
    });
  }
  return records;
}

function calleeRecords(
  graph: InMemoryCodeGraph,
  symbol: string,
  scope: string,
): CodeRelationRecord[] {
  const owners = matchingNodes(graph, symbol).filter((node) =>
    pathInScope(graph, node.file, scope),
  );
  const records: CodeRelationRecord[] = [];
  for (const owner of owners) {
    for (const edge of graph.edgesBySource.get(owner.id) ?? []) {
      if (edge.kind !== "call") continue;
      const target = graph.nodesById.get(edge.target);
      const targetName = target?.name ?? edge.target.replace(/^\?:/, "");
      records.push({
        file: owner.file,
        line: edge.line,
        column: edge.col,
        relation: "callees",
        symbol: targetName,
        ...confidenceFields(edge.provenance),
        from: symbolRef(owner),
        ...(target ? { to: symbolRef(target) } : {}),
      });
    }
  }
  return records;
}

function importsRecords(
  graph: InMemoryCodeGraph,
  symbol: string,
  scope: string,
): CodeRelationRecord[] {
  const files = matchingFiles(graph, symbol, scope);
  return graph.imports
    .filter((item) => files.has(item.file))
    .map((item) => importRecordToRelation(item, "imports", symbol, "EXTRACTED", "source import"));
}

function importerRecords(
  graph: InMemoryCodeGraph,
  symbol: string,
  scope: string,
): CodeRelationRecord[] {
  const records: CodeRelationRecord[] = [];
  for (const item of graph.imports) {
    if (!pathInScope(graph, item.file, scope)) continue;
    const hit = importTargetsSymbol(graph, item, symbol);
    if (!hit) continue;
    records.push(importRecordToRelation(item, "importers", symbol, hit.tier, hit.reason));
  }
  return records;
}

function importRecordToRelation(
  item: CodeGraphImport,
  relation: FindReferencesArgs["relation"],
  symbol: string,
  confidence: ConfidenceTier,
  reason: string,
): CodeRelationRecord {
  return {
    file: item.file,
    line: item.line,
    column: item.col,
    relation,
    symbol,
    confidence,
    score: confidenceScore[confidence],
    reason,
    module: item.source,
    ...(item.resolvedPath ? { resolvedPath: item.resolvedPath } : {}),
    ...(item.names.length > 0 ? { names: item.names } : {}),
    snippet: item.raw,
  };
}

function importTargetsSymbol(
  graph: InMemoryCodeGraph,
  item: CodeGraphImport,
  symbol: string,
): { tier: ConfidenceTier; reason: string } | null {
  if (
    item.bindings.some((binding) => binding.kind === "named" && binding.importedName === symbol)
  ) {
    return { tier: "INFERRED", reason: "import-scoped binding" };
  }
  if (pathMatchesQuery(item.resolvedPath, symbol)) {
    return { tier: "EXTRACTED", reason: "resolved import path" };
  }
  if (
    !item.resolvedPath &&
    item.bindings.some((binding) => binding.kind !== "default" && binding.localName === symbol)
  ) {
    return { tier: "INFERRED", reason: "import-scoped binding" };
  }
  if (!item.resolvedPath) return null;
  const importedNodes = nodesInFile(graph, item.resolvedPath);
  if (item.kind === "import" && item.bindings.some((binding) => isDefaultImportBinding(binding))) {
    return importedNodes.some(
      (node) => node.exportKind === "default" && nodeMatchesSymbol(node, symbol),
    )
      ? { tier: "INFERRED", reason: "default import binding" }
      : null;
  }
  if (
    item.kind === "import" &&
    item.bindings.some((binding) => binding.kind === "namespace" && !binding.typeOnly) &&
    importedNodes.some((node) => nodeMatchesSymbol(node, symbol))
  ) {
    return { tier: "INFERRED", reason: "namespace import binding" };
  }
  if (item.kind === "import") return null;
  if (item.bindings.some((binding) => binding.importedName === "default")) {
    return importedNodes.some(
      (node) => node.exportKind === "default" && nodeMatchesSymbol(node, symbol),
    )
      ? { tier: "INFERRED", reason: "default re-export binding" }
      : null;
  }
  if (item.bindings.length > 0) return null;
  if (importedNodes.some((node) => nodeMatchesSymbol(node, symbol))) {
    return { tier: "INFERRED", reason: "resolved import source" };
  }
  return null;
}

function isDefaultImportBinding(binding: CodeGraphImport["bindings"][number]): boolean {
  return binding.kind === "default" || binding.importedName === "default";
}

function matchingFiles(graph: InMemoryCodeGraph, symbol: string, scope: string): Set<string> {
  const files = new Set<string>();
  for (const file of Object.keys(graph.files)) {
    if (pathInScope(graph, file, scope) && pathMatchesQuery(file, symbol)) files.add(file);
  }
  for (const node of matchingNodes(graph, symbol)) {
    if (pathInScope(graph, node.file, scope)) files.add(node.file);
  }
  return files;
}

function nodesInFile(graph: InMemoryCodeGraph, file: string): CodeGraphNode[] {
  return graph.nodes.filter((node) => node.file === file);
}

function matchingNodes(graph: InMemoryCodeGraph, symbol: string): CodeGraphNode[] {
  const direct = graph.nodesByName.get(symbol) ?? [];
  if (direct.length > 0) return direct;
  return graph.nodes.filter((node) => nodeMatchesSymbol(node, symbol));
}

function nodeMatchesSymbol(node: CodeGraphNode, symbol: string): boolean {
  if (node.name === symbol) return true;
  const parent = parentName(node);
  return (
    (parent !== undefined && `${parent}.${node.name}` === symbol) ||
    (parent !== undefined && `${parent}#${node.name}` === symbol) ||
    node.qualifiedName === symbol ||
    node.qualifiedName.endsWith(`::${symbol}`)
  );
}

function parentName(node: CodeGraphNode): string | undefined {
  const parts = node.qualifiedName.split("::");
  return parts.length >= 3 ? parts[parts.length - 2] : undefined;
}

function confidenceFields(
  provenance: CodeGraphEdgeProvenance,
): Pick<CodeRelationRecord, "confidence" | "score" | "reason"> {
  const confidence =
    provenance === "extracted" ? "EXTRACTED" : provenance === "inferred" ? "INFERRED" : "AMBIGUOUS";
  return {
    confidence,
    score: confidenceScore[confidence],
    reason: `code-graph ${provenance}`,
  };
}

function symbolRef(node: CodeGraphNode): SymbolRef {
  const parent = parentName(node);
  return {
    name: node.name,
    file: node.file,
    line: node.startLine,
    kind: node.kind,
    ...(parent ? { parent } : {}),
  };
}

function filesInScope(graph: InMemoryCodeGraph, scope: string): Set<string> {
  const files = new Set<string>();
  for (const path of Object.keys(graph.files)) {
    if (pathInScope(graph, path, scope)) files.add(path);
  }
  return files;
}

function pathInScope(graph: InMemoryCodeGraph, path: string, rawScope: string): boolean {
  const scope = normalizeScope(graph.root, rawScope);
  if (scope === ".") return true;
  return path === scope || path.startsWith(`${scope}/`);
}

function pathMatchesQuery(path: string | undefined, query: string): boolean {
  if (!path) return false;
  const normalized = query.replaceAll("\\", "/").replace(/^\/+/, "");
  return (
    path === normalized ||
    path.endsWith(`/${normalized}`) ||
    path.replace(/\.[^.]+$/, "") === normalized.replace(/\.[^.]+$/, "")
  );
}

function normalizeScope(root: string, rawScope: string): string {
  const stripped = rawScope.trim().replace(/^[/\\]+/, "");
  const resolved = resolve(root, stripped.length === 0 ? "." : stripped);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${rawScope}`);
  }
  return rel.replaceAll("\\", "/") || ".";
}

function dedupeRecords(records: readonly CodeRelationRecord[]): CodeRelationRecord[] {
  const seen = new Set<string>();
  const out: CodeRelationRecord[] = [];
  for (const record of records) {
    const key = [
      record.relation,
      record.file,
      record.line,
      record.column,
      record.symbol,
      record.from?.name ?? "",
      record.to?.name ?? "",
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function sortRecords(records: CodeRelationRecord[]): CodeRelationRecord[] {
  return records.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.symbol.localeCompare(b.symbol) ||
      (a.from?.name ?? "").localeCompare(b.from?.name ?? ""),
  );
}

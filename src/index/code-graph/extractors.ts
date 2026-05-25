import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  type GrammarName,
  type ParseSourceOptions,
  grammarForPath,
} from "../../code-query/parser.js";
import type { CodeSymbol, SymbolKind } from "../../code-query/symbols.js";
import type {
  CodeGraphEdge,
  CodeGraphImport,
  CodeGraphImportBinding,
  CodeGraphNode,
  CodeGraphUnresolvedRef,
} from "./types.js";

export interface ExtractCodeGraphFileResult {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  unresolvedRefs: CodeGraphUnresolvedRef[];
  imports: CodeGraphImport[];
}

export interface ExtractCodeGraphOptions {
  includeBody?: boolean;
  projectFiles?: ReadonlySet<string>;
}

interface SymbolNodePair {
  symbol: CodeSymbol;
  node: CodeGraphNode;
}

export async function extractCodeGraphFile(
  root: string,
  absPath: string,
  relPath: string,
  source: string,
  stat: Stats,
  parseOpts: ParseSourceOptions = {},
  opts: ExtractCodeGraphOptions = {},
): Promise<ExtractCodeGraphFileResult> {
  void stat;
  void parseOpts;
  const lines = source.split(/\r?\n/);
  const symbols = extractFastSymbols(absPath, lines);
  const pairs = symbols.map((symbol) => ({
    symbol,
    node: symbolToNode(relPath, symbol, lines, opts),
  }));
  const nodes = pairs.map((pair) => pair.node);
  const imports = extractImports(root, absPath, relPath, lines, opts);
  return {
    nodes,
    edges: extractContainsEdges(pairs),
    unresolvedRefs: [
      ...(await extractCallRefs(absPath, relPath, lines, pairs)),
      ...extractInheritanceRefs(relPath, source, lines, nodes),
      ...extractImportRefs(imports, nodes),
    ],
    imports,
  };
}

function symbolToNode(
  file: string,
  symbol: CodeSymbol,
  lines: readonly string[],
  opts: ExtractCodeGraphOptions,
): CodeGraphNode {
  const qualifiedName = [file, symbol.parent, symbol.name].filter(Boolean).join("::");
  return {
    id: nodeId(file, qualifiedName, symbol.line),
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName,
    file,
    startLine: symbol.line,
    endLine: symbol.endLine,
    ...defaultExportField(lines, symbol),
    ...(opts.includeBody ? bodyFields(lines, symbol) : {}),
  };
}

function defaultExportField(
  lines: readonly string[],
  symbol: CodeSymbol,
): Pick<CodeGraphNode, "exportKind"> {
  const line = lines[symbol.line - 1] ?? "";
  return /^\s*export\s+default\b/.test(line) ? { exportKind: "default" } : {};
}

function bodyFields(
  lines: readonly string[],
  symbol: CodeSymbol,
): Pick<CodeGraphNode, "signature" | "docstring"> {
  const signature = lines[symbol.line - 1]?.trim();
  const docstring = leadingDocComment(lines, symbol.line - 2);
  return {
    ...(signature ? { signature } : {}),
    ...(docstring ? { docstring } : {}),
  };
}

function leadingDocComment(lines: readonly string[], beforeIndex: number): string | undefined {
  const previous = lines[beforeIndex]?.trim();
  if (!previous) return undefined;
  if (previous.startsWith("//") || previous.startsWith("#")) {
    return collectLineComments(lines, beforeIndex, previous.startsWith("#") ? "#" : "//");
  }
  if (previous.endsWith("*/")) return collectBlockComment(lines, beforeIndex);
  return undefined;
}

function collectLineComments(
  lines: readonly string[],
  startIndex: number,
  marker: "#" | "//",
): string {
  const parts: string[] = [];
  for (let index = startIndex; index >= 0; index--) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed.startsWith(marker)) break;
    parts.unshift(trimmed.slice(marker.length).trim());
  }
  return parts.join("\n").trim();
}

function collectBlockComment(lines: readonly string[], startIndex: number): string | undefined {
  const parts: string[] = [];
  for (let index = startIndex; index >= 0; index--) {
    const trimmed = lines[index]?.trim() ?? "";
    parts.unshift(
      trimmed
        .replace(/^\/\*\*?/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*/, "")
        .trim(),
    );
    if (trimmed.startsWith("/*")) break;
  }
  const doc = parts.filter(Boolean).join("\n").trim();
  return doc || undefined;
}

function extractFastSymbols(filePath: string, lines: readonly string[]): CodeSymbol[] {
  const grammar = grammarForPath(filePath);
  if (!grammar) return [];
  if (grammar === "python") return extractPythonSymbols(lines);
  // Pre-mask the entire file once so findBraceBlockEnd counts only real braces
  // — strings/comments are blanked out. Fixes P0-3 endLine truncation on bodies
  // containing `"}"` / `// }` / etc.
  const maskedLines = maskAllLines(lines, grammar);
  if (grammar === "go") return extractGoSymbols(lines, maskedLines);
  if (grammar === "rust") return extractRustSymbols(lines, maskedLines);
  if (grammar === "java") return extractJavaSymbols(lines, maskedLines);
  return extractEcmaSymbols(lines, maskedLines);
}

function maskAllLines(lines: readonly string[], grammar: GrammarName): string[] {
  const state: MaskState = { blockComment: false, quote: null };
  return lines.map((line) => maskCodeLine(line, grammar, state));
}

interface ContainerScope {
  name: string;
  endLine: number;
}

function extractEcmaSymbols(
  lines: readonly string[],
  maskedLines: readonly string[],
): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const containers: ContainerScope[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    dropClosedContainers(containers, lineNumber);
    const classMatch = line.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    );
    if (classMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "class",
        classMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      containers.push({
        name: classMatch[1],
        endLine: out[out.length - 1]?.endLine ?? lineNumber,
      });
      return;
    }
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (interfaceMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "interface",
        interfaceMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      containers.push({
        name: interfaceMatch[1],
        endLine: out[out.length - 1]?.endLine ?? lineNumber,
      });
      return;
    }
    const enumMatch = line.match(/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/);
    if (enumMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "enum",
        enumMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      return;
    }
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
    if (typeMatch?.[1]) pushSymbol(out, line, lineNumber, "type", typeMatch[1], lineNumber);
    const functionMatch = line.match(
      // P1-G: accept `function* gen`, `function *gen`, `function*gen` as well as
      // plain `function name`. Two alternatives so we still require a separator
      // and never mis-match `functionfoo`.
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s+|\s*\*\s*)([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\(/,
    );
    if (functionMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "function",
        functionMatch[1],
        findBraceBlockEnd(maskedLines, index),
        currentParent(containers),
      );
      return;
    }
    const arrowMatch = line.match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    );
    if (arrowMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "function",
        arrowMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      return;
    }
    const parent = currentParent(containers);
    if (!parent) return;
    const methodMatch = line.match(
      /^\s*(?:(?:public|private|protected|static|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\([^)]*\)\s*(?::[^={;]+)?[{;]/,
    );
    if (methodMatch?.[1] && methodMatch[1] !== "constructor") {
      pushSymbol(
        out,
        line,
        lineNumber,
        "method",
        methodMatch[1],
        findBraceBlockEnd(maskedLines, index),
        parent,
      );
    }
  });
  return sortSymbols(out);
}

function extractPythonSymbols(lines: readonly string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const containers: Array<ContainerScope & { indent: number }> = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const indent = leadingSpaces(line);
    while (containers.length > 0) {
      const last = containers[containers.length - 1];
      if (last && (lineNumber > last.endLine || indent <= last.indent)) containers.pop();
      else break;
    }
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/);
    if (classMatch?.[2]) {
      const endLine = findPythonBlockEnd(lines, index, indent);
      pushSymbol(out, line, lineNumber, "class", classMatch[2], endLine);
      containers.push({ name: classMatch[2], indent, endLine });
      return;
    }
    const functionMatch = line.match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch?.[2]) {
      const parent = currentParent(containers);
      pushSymbol(
        out,
        line,
        lineNumber,
        parent ? "method" : "function",
        functionMatch[2],
        findPythonBlockEnd(lines, index, indent),
        parent,
      );
    }
  });
  return sortSymbols(out);
}

function extractGoSymbols(lines: readonly string[], maskedLines: readonly string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const methodMatch = line.match(/^\s*func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/);
    if (methodMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "method",
        methodMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      return;
    }
    const functionMatch = line.match(/^\s*func\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        "function",
        functionMatch[1],
        findBraceBlockEnd(maskedLines, index),
      );
      return;
    }
    const typeMatch = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+(.+)/);
    if (!typeMatch?.[1]) return;
    const kind = typeMatch[2]?.includes("interface")
      ? "interface"
      : typeMatch[2]?.includes("struct")
        ? "class"
        : "type";
    pushSymbol(out, line, lineNumber, kind, typeMatch[1], findBraceBlockEnd(maskedLines, index));
  });
  return sortSymbols(out);
}

function extractRustSymbols(
  lines: readonly string[],
  maskedLines: readonly string[],
): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const match = line.match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/,
    );
    if (!match?.[1] || !match[2] || !isRustSymbolKeyword(match[1])) return;
    const kindByKeyword = {
      const: "property",
      enum: "enum",
      fn: "function",
      mod: "namespace",
      static: "property",
      struct: "class",
      trait: "interface",
      type: "type",
    } satisfies Record<RustSymbolKeyword, SymbolKind>;
    pushSymbol(
      out,
      line,
      lineNumber,
      kindByKeyword[match[1]],
      match[2],
      findBraceBlockEnd(maskedLines, index),
    );
  });
  return sortSymbols(out);
}

type RustSymbolKeyword = "const" | "enum" | "fn" | "mod" | "static" | "struct" | "trait" | "type";

function isRustSymbolKeyword(value: string): value is RustSymbolKeyword {
  return (
    value === "const" ||
    value === "enum" ||
    value === "fn" ||
    value === "mod" ||
    value === "static" ||
    value === "struct" ||
    value === "trait" ||
    value === "type"
  );
}

function extractJavaSymbols(
  lines: readonly string[],
  maskedLines: readonly string[],
): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const containers: ContainerScope[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    dropClosedContainers(containers, lineNumber);
    const typeMatch = line.match(/\b(class|interface|enum)\s+([A-Za-z_]\w*)/);
    if (typeMatch?.[1] && typeMatch[2]) {
      const kind =
        typeMatch[1] === "class" ? "class" : typeMatch[1] === "interface" ? "interface" : "enum";
      pushSymbol(out, line, lineNumber, kind, typeMatch[2], findBraceBlockEnd(maskedLines, index));
      containers.push({
        name: typeMatch[2],
        endLine: out[out.length - 1]?.endLine ?? lineNumber,
      });
      return;
    }
    const parent = currentParent(containers);
    const methodMatch = line.match(
      /^\s*(?:public|private|protected|static|final|abstract|synchronized|native|\s)+[\w<>\[\], ?]+?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[\w, ]+)?\{/,
    );
    if (methodMatch?.[1]) {
      pushSymbol(
        out,
        line,
        lineNumber,
        parent ? "method" : "function",
        methodMatch[1],
        findBraceBlockEnd(maskedLines, index),
        parent,
      );
    }
  });
  return sortSymbols(out);
}

function pushSymbol(
  out: CodeSymbol[],
  line: string,
  lineNumber: number,
  kind: SymbolKind,
  name: string,
  endLine: number,
  parent?: string,
): void {
  out.push({
    name,
    kind,
    line: lineNumber,
    column: Math.max(1, line.indexOf(name) + 1),
    endLine,
    endColumn: Math.max(1, line.length + 1),
    ...(parent ? { parent } : {}),
  });
}

/** Counts braces on masked lines (strings/comments already blanked out) so a
 * body like `function f(){ const s = "}"; return 0; }` is no longer truncated
 * to its `"}"` literal. Callers must pass maskAllLines() output, not raw lines. */
function findBraceBlockEnd(maskedLines: readonly string[], startIndex: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < maskedLines.length; i++) {
    const line = maskedLines[i] ?? "";
    for (const char of line) {
      if (char === "{") {
        depth++;
        started = true;
      } else if (char === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) return i + 1;
  }
  return startIndex + 1;
}

function findPythonBlockEnd(lines: readonly string[], startIndex: number, indent: number): number {
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    if (leadingSpaces(line) <= indent) return i;
  }
  return lines.length;
}

function leadingSpaces(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function dropClosedContainers(containers: ContainerScope[], lineNumber: number): void {
  while (containers.length > 0 && lineNumber > (containers[containers.length - 1]?.endLine ?? 0)) {
    containers.pop();
  }
}

function currentParent(containers: readonly ContainerScope[]): string | undefined {
  return containers[containers.length - 1]?.name;
}

function sortSymbols(symbols: readonly CodeSymbol[]): CodeSymbol[] {
  return [...symbols].sort(
    (a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name),
  );
}

function nodeId(file: string, qualifiedName: string, startLine: number): string {
  return createHash("sha256")
    .update(`${file}\0${qualifiedName}\0${startLine}`)
    .digest("hex")
    .slice(0, 16);
}

function extractContainsEdges(pairs: readonly SymbolNodePair[]): CodeGraphEdge[] {
  const edges: CodeGraphEdge[] = [];
  const pairsByName = new Map<string, SymbolNodePair[]>();
  for (const pair of pairs) {
    const list = pairsByName.get(pair.node.name);
    if (list) list.push(pair);
    else pairsByName.set(pair.node.name, [pair]);
  }
  for (const child of pairs) {
    if (!child.symbol.parent) continue;
    const parent = (pairsByName.get(child.symbol.parent) ?? []).find(
      (candidate) =>
        candidate.node.id !== child.node.id &&
        candidate.node.name === child.symbol.parent &&
        candidate.node.startLine <= child.node.startLine &&
        candidate.node.endLine >= child.node.endLine,
    );
    if (!parent) continue;
    edges.push({
      source: parent.node.id,
      target: child.node.id,
      kind: "contains",
      line: child.node.startLine,
      col: 1,
      provenance: "extracted",
    });
  }
  return edges;
}

async function extractCallRefs(
  absPath: string,
  relPath: string,
  lines: readonly string[],
  pairs: readonly SymbolNodePair[],
): Promise<CodeGraphUnresolvedRef[]> {
  const refs: CodeGraphUnresolvedRef[] = [];
  const grammar = grammarForPath(absPath);
  const maskState: MaskState = { blockComment: false, quote: null };
  const ownerCache = new Map<number, SymbolNodePair | null>();
  lines.forEach((line, index) => {
    const needsMasking = lineNeedsMasking(line, grammar);
    if (!maskState.blockComment && !maskState.quote && !line.includes("(") && !needsMasking) {
      return;
    }
    const codeLine =
      !maskState.blockComment && !maskState.quote && !needsMasking
        ? line
        : maskCodeLine(line, grammar, maskState);
    if (!codeLine.includes("(")) return;
    const lineNumber = index + 1;
    const owner = ownerForLine(pairs, lineNumber, ownerCache);
    if (!owner) return;
    const originalLine = lines[index] ?? "";
    for (const match of codeLine.matchAll(
      /\b(?:(?<receiver>[A-Za-z_$][\w$]*)\s*\.\s*)?(?<name>[A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      const name = match.groups?.name;
      const receiverName = match.groups?.receiver;
      const callIndex = (match.index ?? 0) + (match[0].lastIndexOf(name ?? "") ?? 0);
      if (!name || shouldSkipCallCandidate(originalLine, callIndex, name)) continue;
      refs.push({
        source: owner.node.id,
        targetName: name,
        kind: "call",
        file: relPath,
        line: lineNumber,
        col: callIndex + 1,
        ...(receiverName ? { receiverName } : {}),
      });
    }
  });
  return sortUnresolvedRefs(refs);
}

interface MaskState {
  blockComment: boolean;
  quote: string | null;
}

function maskCodeLine(line: string, grammar: GrammarName | null, state: MaskState): string {
  let masked = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (state.blockComment) {
      masked += " ";
      if (char === "*" && next === "/") {
        masked += " ";
        index += 2;
        state.blockComment = false;
      } else {
        index += 1;
      }
      continue;
    }
    if (state.quote) {
      masked += " ";
      if (char === "\\") {
        masked += index + 1 < line.length ? " " : "";
        index += 2;
        continue;
      }
      if (char === state.quote) state.quote = null;
      index += 1;
      continue;
    }
    if (usesSlashComments(grammar) && char === "/" && next === "/") {
      masked += " ".repeat(line.length - index);
      break;
    }
    if (usesSlashComments(grammar) && char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      state.blockComment = true;
      continue;
    }
    if (grammar === "python" && char === "#") {
      masked += " ".repeat(line.length - index);
      break;
    }
    if (char === '"' || char === "'" || char === "`") {
      masked += " ";
      state.quote = char;
      index += 1;
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

function usesSlashComments(grammar: GrammarName | null): boolean {
  return grammar !== "python";
}

function lineNeedsMasking(line: string, grammar: GrammarName | null): boolean {
  if (usesSlashComments(grammar) && line.includes("/")) return true;
  if (grammar === "python" && line.includes("#")) return true;
  return line.includes('"') || line.includes("'") || line.includes("`");
}

function sortUnresolvedRefs(refs: CodeGraphUnresolvedRef[]): CodeGraphUnresolvedRef[] {
  return refs.sort(
    (a, b) => a.line - b.line || a.col - b.col || a.targetName.localeCompare(b.targetName),
  );
}

function ownerForLine(
  pairs: readonly SymbolNodePair[],
  line: number,
  cache: Map<number, SymbolNodePair | null>,
): SymbolNodePair | undefined {
  if (cache.has(line)) return cache.get(line) ?? undefined;
  let best: SymbolNodePair | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const pair of pairs) {
    if (pair.node.startLine > line || pair.node.endLine < line) continue;
    const span = pair.node.endLine - pair.node.startLine;
    if (
      span < bestSpan ||
      (span === bestSpan && pair.node.startLine > (best?.node.startLine ?? 0))
    ) {
      best = pair;
      bestSpan = span;
    }
  }
  cache.set(line, best ?? null);
  return best;
}

const NON_CALL_IDENTIFIERS = new Set(["catch", "for", "function", "if", "switch", "while"]);

function shouldSkipCallCandidate(line: string, index: number, name: string): boolean {
  if (NON_CALL_IDENTIFIERS.has(name)) return true;
  const before = line.slice(0, index);
  const after = line.slice(index + name.length);
  if (/\b(function|class|interface|type)\s+$/.test(before)) return true;
  if (/^\s*\([^)]*\)\s*[:\w\s<>,[\]|&?.]*\{/.test(after) && before.trim() === "") return true;
  return false;
}

function extractInheritanceRefs(
  file: string,
  source: string,
  lines: readonly string[],
  nodes: readonly CodeGraphNode[],
): CodeGraphUnresolvedRef[] {
  if (!/\b(?:extends|implements)\b/.test(source)) return [];
  const refs: CodeGraphUnresolvedRef[] = [];
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const classMatch = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/);
    if (classMatch?.[1] && classMatch[2]) {
      pushInheritanceRef(
        refs,
        nodesByName,
        file,
        line,
        lineNumber,
        classMatch[1],
        classMatch[2],
        "extends",
      );
    }
    const implementsMatch = line.match(
      /\bclass\s+([A-Za-z_$][\w$]*).*?\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/,
    );
    if (implementsMatch?.[1] && implementsMatch[2]) {
      for (const name of namesFromCommaList(implementsMatch[2])) {
        pushInheritanceRef(
          refs,
          nodesByName,
          file,
          line,
          lineNumber,
          implementsMatch[1],
          name,
          "implements",
        );
      }
    }
    const interfaceMatch = line.match(
      /\binterface\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/,
    );
    if (interfaceMatch?.[1] && interfaceMatch[2]) {
      for (const name of namesFromCommaList(interfaceMatch[2])) {
        pushInheritanceRef(
          refs,
          nodesByName,
          file,
          line,
          lineNumber,
          interfaceMatch[1],
          name,
          "extends",
        );
      }
    }
  });
  return refs;
}

function pushInheritanceRef(
  refs: CodeGraphUnresolvedRef[],
  nodesByName: ReadonlyMap<string, CodeGraphNode>,
  file: string,
  line: string,
  lineNumber: number,
  sourceName: string,
  targetName: string,
  kind: CodeGraphUnresolvedRef["kind"],
): void {
  const source = nodesByName.get(sourceName);
  if (!source) return;
  refs.push({
    source: source.id,
    targetName,
    kind,
    file,
    line: lineNumber,
    col: Math.max(1, line.indexOf(targetName) + 1),
  });
}

function extractImportRefs(
  imports: readonly CodeGraphImport[],
  nodes: readonly CodeGraphNode[],
): CodeGraphUnresolvedRef[] {
  const anchor = nodes[0];
  if (!anchor) return [];
  return imports.flatMap((item) => {
    const targetNames =
      item.bindings.length > 0
        ? item.bindings.map((binding) => binding.importedName)
        : [basename(item.source)];
    return uniqueStrings(targetNames).map((name) => ({
      source: anchor.id,
      targetName: name,
      kind: "import" as const,
      file: item.file,
      line: item.line,
      col: item.col,
      importSource: item.source,
    }));
  });
}

function extractImports(
  root: string,
  absPath: string,
  file: string,
  lines: readonly string[],
  opts: ExtractCodeGraphOptions,
): CodeGraphImport[] {
  const grammar = grammarForPath(file);
  if (!grammar) return [];
  const rawImports =
    grammar === "typescript" || grammar === "tsx" || grammar === "javascript"
      ? extractEcmaImports(file, lines)
      : grammar === "python"
        ? extractPythonImports(file, lines)
        : grammar === "java"
          ? extractJavaImports(file, lines)
          : grammar === "go"
            ? extractGoImports(file, lines)
            : grammar === "rust"
              ? extractRustImports(file, lines)
              : [];
  return rawImports.map((item) => {
    const resolvedPath = resolveImportPath(root, absPath, item.source, opts.projectFiles);
    return resolvedPath ? { ...item, resolvedPath: rootRelativePath(root, resolvedPath) } : item;
  });
}

function extractEcmaImports(file: string, lines: readonly string[]): CodeGraphImport[] {
  const out: CodeGraphImport[] = [];
  lines.forEach((line, index) => {
    const importMatch = line.match(/^\s*import\s+(type\s+)?(?:(.*?)\s+from\s+)?["']([^"']+)["']/);
    if (importMatch?.[3]) {
      const normalized = normalizeEcmaImportClause(
        importMatch[2] ?? "",
        importMatch[1] !== undefined,
      );
      const parsed = namesFromEcmaClause(normalized.clause, {
        typeOnly: normalized.typeOnly,
      });
      out.push({
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: importMatch[3],
        kind: "import",
        names: parsed.names,
        bindings: parsed.bindings,
        raw: line,
      });
      return;
    }
    const exportMatch = line.match(
      /^\s*export\s+(?:type\s+)?(?:\*|(\{.*\})|[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/,
    );
    if (exportMatch?.[2]) {
      const bindings = bindingsFromNamedList(exportMatch[1] ?? "");
      out.push({
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: exportMatch[2],
        kind: "export",
        names: localNamesFromBindings(bindings),
        bindings,
        raw: line,
      });
    }
  });
  return out;
}

function normalizeEcmaImportClause(
  clause: string,
  typePrefix: boolean,
): { clause: string; typeOnly: boolean } {
  const trimmed = clause.trim();
  if (!typePrefix && trimmed.startsWith("type ")) {
    return { clause: trimmed.replace(/^type\s+/, ""), typeOnly: true };
  }
  return { clause, typeOnly: typePrefix };
}

function namesFromEcmaClause(
  clause: string,
  opts: { typeOnly?: boolean } = {},
): {
  names: string[];
  bindings: CodeGraphImportBinding[];
} {
  const trimmed = clause.trim();
  if (!trimmed) return { names: [], bindings: [] };
  const names: string[] = [];
  const bindings: CodeGraphImportBinding[] = [];
  const named = trimmed.match(/\{([^}]+)\}/)?.[0] ?? "";
  if (named) bindings.push(...bindingsFromNamedList(named, opts));
  const namespace = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace?.[1]) {
    names.push(namespace[1]);
    bindings.push({
      importedName: "*",
      localName: namespace[1],
      kind: "namespace",
      ...(opts.typeOnly ? { typeOnly: true } : {}),
    });
  }
  const beforeComma = trimmed.split(",")[0]?.trim() ?? "";
  if (beforeComma && !beforeComma.startsWith("{") && !beforeComma.startsWith("*")) {
    const name = beforeComma.replace(/^type\s+/, "");
    names.push(name);
    bindings.push({
      importedName: name,
      localName: name,
      kind: "default",
      ...(opts.typeOnly ? { typeOnly: true } : {}),
    });
  }
  names.push(...localNamesFromBindings(bindings));
  return {
    names: uniqueStrings(names.filter(Boolean)),
    bindings: uniqueBindings(bindings),
  };
}

function bindingsFromNamedList(
  text: string,
  opts: { typeOnly?: boolean } = {},
): CodeGraphImportBinding[] {
  const body = text.replace(/[{}]/g, "");
  const bindings: CodeGraphImportBinding[] = [];
  for (const part of body.split(",")) {
    const raw = part.trim();
    const partTypeOnly = opts.typeOnly || raw.startsWith("type ");
    const cleaned = raw.replace(/^type\s+/, "");
    if (!cleaned) continue;
    const aliasParts = cleaned.split(/\s+as\s+/);
    const importedName = aliasParts[0]?.trim() ?? "";
    const localName = aliasParts.at(-1)?.trim() ?? "";
    if (isIdentifierName(importedName) && isIdentifierName(localName)) {
      bindings.push({
        importedName,
        localName,
        kind: "named",
        ...(partTypeOnly ? { typeOnly: true } : {}),
      });
    }
  }
  return uniqueBindings(bindings);
}

function localNamesFromBindings(bindings: readonly CodeGraphImportBinding[]): string[] {
  return uniqueStrings(bindings.map((binding) => binding.localName));
}

function uniqueBindings(bindings: readonly CodeGraphImportBinding[]): CodeGraphImportBinding[] {
  const seen = new Set<string>();
  const out: CodeGraphImportBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.kind}\0${binding.importedName}\0${binding.localName}\0${binding.typeOnly ? "type" : "value"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function extractPythonImports(file: string, lines: readonly string[]): CodeGraphImport[] {
  const out: CodeGraphImport[] = [];
  lines.forEach((line, index) => {
    const fromMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch?.[1] && fromMatch[2]) {
      const bindings = bindingsFromCommaList(fromMatch[2]);
      out.push({
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: fromMatch[1],
        kind: "import",
        names: localNamesFromBindings(bindings),
        bindings,
        raw: line,
      });
      return;
    }
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch?.[1]) {
      const names = namesFromCommaList(importMatch[1]);
      out.push({
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: importMatch[1].split(",")[0]?.trim() ?? "",
        kind: "import",
        names,
        bindings: bindingsFromNames(names),
        raw: line,
      });
    }
  });
  return out;
}

function extractJavaImports(file: string, lines: readonly string[]): CodeGraphImport[] {
  return lines.flatMap((line, index): CodeGraphImport[] => {
    const match = line.match(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/);
    if (!match?.[1]) return [];
    const parts = match[1].split(".");
    return [
      {
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: match[1],
        kind: "import",
        names: uniqueStrings([parts[parts.length - 1] ?? ""]),
        bindings: bindingsFromNames(uniqueStrings([parts[parts.length - 1] ?? ""])),
        raw: line,
      },
    ];
  });
}

function extractGoImports(file: string, lines: readonly string[]): CodeGraphImport[] {
  const out: CodeGraphImport[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:import\s+)?(?:[A-Za-z_]\w*\s+)?["']([^"']+)["']/);
    if (!match?.[1]) return;
    out.push({
      file,
      line: index + 1,
      col: line.search(/\S/) + 1,
      source: match[1],
      kind: "import",
      names: [basename(match[1])],
      bindings: bindingsFromNames([basename(match[1])]),
      raw: line,
    });
  });
  return out;
}

function extractRustImports(file: string, lines: readonly string[]): CodeGraphImport[] {
  return lines.flatMap((line, index): CodeGraphImport[] => {
    const match = line.match(/^\s*use\s+([^;]+);/);
    if (!match?.[1]) return [];
    const names = match[1]
      .replace(/[{}]/g, "")
      .split(/::|,/)
      .map((part) => part.trim())
      .filter((part) => /^[A-Za-z_]\w*$/.test(part));
    return [
      {
        file,
        line: index + 1,
        col: line.search(/\S/) + 1,
        source: match[1].trim(),
        kind: "import",
        names: uniqueStrings(names),
        bindings: bindingsFromNames(uniqueStrings(names)),
        raw: line,
      },
    ];
  });
}

function bindingsFromCommaList(text: string): CodeGraphImportBinding[] {
  const bindings = text
    .split(",")
    .map((part) => {
      const cleaned = part.trim();
      const aliasParts = cleaned.split(/\s+as\s+/);
      const importedName = aliasParts[0]?.trim() ?? "";
      const localName = aliasParts.at(-1)?.trim() ?? "";
      return { importedName, localName, kind: "named" as const };
    })
    .filter(
      (binding) => isIdentifierName(binding.importedName) && isIdentifierName(binding.localName),
    );
  return uniqueBindings(bindings);
}

function bindingsFromNames(names: readonly string[]): CodeGraphImportBinding[] {
  return uniqueBindings(
    names.filter(isIdentifierName).map((name) => ({
      importedName: name,
      localName: name,
      kind: "named" as const,
    })),
  );
}

function namesFromCommaList(text: string): string[] {
  return uniqueStrings(
    text
      .split(",")
      .map(
        (part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .pop() ?? "",
      )
      .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part)),
  );
}

function resolveImportPath(
  root: string,
  fromAbsPath: string,
  source: string,
  projectFiles?: ReadonlySet<string>,
): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const absRoot = resolve(root);
  const base = resolve(fromAbsPath, "..", source);
  for (const candidate of candidateImportPaths(base)) {
    if (isProjectCodeFile(absRoot, candidate, projectFiles)) return candidate;
  }
  for (const candidate of candidateImportPaths(base)) {
    const indexFile = candidateImportPaths(resolve(candidate, "index")).find((item) =>
      isProjectCodeFile(absRoot, item, projectFiles),
    );
    if (indexFile) return indexFile;
  }
  const fallback = resolve(absRoot, source);
  return isProjectCodeFile(absRoot, fallback, projectFiles) ? fallback : undefined;
}

function candidateImportPaths(base: string): string[] {
  const ext = extname(base);
  if (ext) {
    const withoutExt = base.slice(0, -ext.length);
    if (ext === ".js") return [base, `${withoutExt}.ts`, `${withoutExt}.tsx`];
    if (ext === ".mjs") return [base, `${withoutExt}.mts`, `${withoutExt}.ts`];
    if (ext === ".cjs") return [base, `${withoutExt}.cts`, `${withoutExt}.ts`];
    if (ext === ".jsx") return [base, `${withoutExt}.tsx`, `${withoutExt}.ts`];
    return [base];
  }
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}.go`,
    `${base}.rs`,
    `${base}.java`,
  ];
}

function rootRelativePath(root: string, absPath: string): string {
  const rel = relative(resolve(root), resolve(absPath));
  return rel.replaceAll("\\", "/");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isProjectCodeFile(
  root: string,
  candidate: string,
  projectFiles?: ReadonlySet<string>,
): boolean {
  const resolved = resolve(candidate);
  if (!isWithinRoot(root, resolved) || grammarForPath(resolved) === null) return false;
  if (projectFiles) return projectFiles.has(rootRelativePath(root, resolved));
  try {
    return lstatSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

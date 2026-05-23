import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { classifyIdentifierNode, isIdentifierNode, walkCodeNodes } from "./find-in-code.js";
import {
  type ParseSourceOptions,
  type ParseTreeCache,
  grammarForPath,
  parseSource,
} from "./parser.js";
import { recordCodeRelationQuery } from "./stats.js";
import { type CodeSymbol, extractSymbols } from "./symbols.js";

const execFileAsync = promisify(execFile);

export type FindReferenceRelation = "callers" | "callees" | "importers" | "imports";
export type DetectChangesScope = "unstaged" | "staged" | "all";
export type ConfidenceTier = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface FindReferencesArgs {
  symbol: string;
  relation: FindReferenceRelation;
  scope?: string;
}

export interface DetectChangesArgs {
  scope?: DetectChangesScope;
  includeCallers?: boolean;
}

export interface ImpactArgs {
  symbol: string;
  direction?: "callers";
  maxDepth?: number;
  minConfidence?: ConfidenceTier;
  scope?: string;
}

export interface CodeRelationRuntimeOptions {
  parseCache?: ParseTreeCache;
}

export interface SymbolRef {
  name: string;
  file: string;
  line: number;
  kind?: string;
  parent?: string;
}

export interface CodeRelationRecord {
  file: string;
  line: number;
  column: number;
  relation: FindReferenceRelation;
  symbol: string;
  confidence: ConfidenceTier;
  score: number;
  reason: string;
  from?: SymbolRef;
  to?: SymbolRef;
  module?: string;
  resolvedPath?: string;
  names?: string[];
  snippet?: string;
}

export interface FindReferencesResult {
  symbol: string;
  relation: FindReferenceRelation;
  scope: string;
  bestEffort: true;
  candidatesScanned: number;
  truncated: boolean;
  records: CodeRelationRecord[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lineStart: number;
  lineEnd: number;
}

export interface ChangedSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  parent?: string;
}

export interface ChangedFile {
  path: string;
  hunks: DiffHunk[];
  symbols: ChangedSymbol[];
  error?: string;
}

export interface DetectChangesResult {
  scope: DetectChangesScope;
  bestEffort: true;
  changedFiles: ChangedFile[];
  callers?: Array<{
    symbol: string;
    file: string;
    records: CodeRelationRecord[];
  }>;
}

export interface ImpactDepthGroup {
  depth: number;
  records: CodeRelationRecord[];
}

export interface ImpactResult {
  symbol: string;
  direction: "callers";
  requestedDepth: number;
  maxDepth: number;
  minConfidence: ConfidenceTier;
  bestEffort: true;
  capped: boolean;
  truncated: boolean;
  groups: ImpactDepthGroup[];
}

interface ProjectFile {
  path: string;
  absPath: string;
  source: string;
  symbols: CodeSymbol[];
  calls: CallOccurrence[];
  imports: ImportRecord[];
}

interface ProjectSnapshot {
  files: ProjectFile[];
  truncated: boolean;
}

interface CallOccurrence {
  file: string;
  line: number;
  column: number;
  name: string;
  snippet: string;
  owner?: SymbolRef;
}

interface ImportRecord {
  file: string;
  line: number;
  column: number;
  source: string;
  names: string[];
  raw: string;
  resolvedPath?: string;
}

const MAX_SCAN_FILES = 5000;
const MAX_IMPACT_RECORDS = 100;
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
const CONFIDENCE_ORDER: ConfidenceTier[] = ["AMBIGUOUS", "INFERRED", "EXTRACTED"];

const confidenceScore = {
  EXTRACTED: 0.95,
  INFERRED: 0.9,
  AMBIGUOUS: 0.5,
} satisfies Record<ConfidenceTier, number>;

export async function findReferences(
  rootDir: string,
  args: FindReferencesArgs,
  opts: CodeRelationRuntimeOptions = {},
): Promise<FindReferencesResult> {
  const symbol = normalizeSymbol(args.symbol);
  const scope = args.scope?.trim() || ".";
  const snapshot = await loadProjectSnapshot(rootDir, scope, opts);
  let records: CodeRelationRecord[];
  if (args.relation === "callers") {
    records = callerRecords(snapshot, symbol);
  } else if (args.relation === "callees") {
    records = calleeRecords(snapshot, symbol);
  } else if (args.relation === "imports") {
    records = importsRecords(snapshot, symbol);
  } else {
    records = importerRecords(snapshot, symbol);
  }
  records = sortRecords(dedupeRecords(records));
  recordCodeRelationQuery({
    candidatesScanned: snapshot.files.length,
    relations: records.length,
    savedRoundsEstimate: estimateSavedRounds(records.length),
  });
  return {
    symbol,
    relation: args.relation,
    scope,
    bestEffort: true,
    candidatesScanned: snapshot.files.length,
    truncated: snapshot.truncated,
    records,
  };
}

export async function detectChanges(
  rootDir: string,
  args: DetectChangesArgs = {},
  opts: CodeRelationRuntimeOptions = {},
): Promise<DetectChangesResult> {
  const scope = args.scope ?? "unstaged";
  const diff = await readGitDiff(rootDir, scope);
  const hunks = parseGitDiff(diff);
  const byPath = groupHunksByPath(hunks);
  const changedFiles: ChangedFile[] = [];
  for (const [path, fileHunks] of [...byPath].sort((a, b) => a[0].localeCompare(b[0]))) {
    const absPath = resolveProjectPath(rootDir, path);
    if (!grammarForPath(absPath)) {
      changedFiles.push({ path, hunks: fileHunks, symbols: [] });
      continue;
    }
    if (!existsSync(absPath)) {
      changedFiles.push({ path, hunks: fileHunks, symbols: [], error: "file not present" });
      continue;
    }
    const source = await readFile(absPath, "utf8");
    const stat = await lstat(absPath);
    const symbols = await extractSymbols(absPath, source, {
      parseCache: opts.parseCache,
      stat,
    });
    changedFiles.push({
      path,
      hunks: fileHunks,
      symbols: affectedSymbols(symbols, fileHunks),
    });
  }

  let callers: DetectChangesResult["callers"];
  if (args.includeCallers) {
    callers = [];
    for (const file of changedFiles) {
      for (const symbol of file.symbols) {
        const refs = await findReferences(
          rootDir,
          {
            symbol: symbol.name,
            relation: "callers",
          },
          opts,
        );
        callers.push({ symbol: symbol.name, file: file.path, records: refs.records });
      }
    }
  }
  const changedSymbolCount = changedFiles.reduce((sum, file) => sum + file.symbols.length, 0);
  recordCodeRelationQuery({
    changedFiles: changedFiles.length,
    relations: changedSymbolCount,
    savedRoundsEstimate: estimateSavedRounds(changedSymbolCount + changedFiles.length),
  });
  return { scope, bestEffort: true, changedFiles, ...(callers ? { callers } : {}) };
}

export async function impact(
  rootDir: string,
  args: ImpactArgs,
  opts: CodeRelationRuntimeOptions = {},
): Promise<ImpactResult> {
  const symbol = normalizeSymbol(args.symbol);
  const requestedDepth = positiveInteger(args.maxDepth) ?? 2;
  const maxDepth = Math.min(2, Math.max(1, requestedDepth));
  const minConfidence = args.minConfidence ?? "AMBIGUOUS";
  const minRank = CONFIDENCE_ORDER.indexOf(minConfidence);
  const groups: ImpactDepthGroup[] = [];
  const seen = new Set([symbol]);
  let frontier = [symbol];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const depthRecords: CodeRelationRecord[] = [];
    const next = new Set<string>();
    for (const current of frontier.sort()) {
      const refs = await findReferences(
        rootDir,
        {
          symbol: current,
          relation: "callers",
          scope: args.scope,
        },
        opts,
      );
      for (const record of refs.records) {
        if (CONFIDENCE_ORDER.indexOf(record.confidence) < minRank) continue;
        depthRecords.push({ ...record, relation: "callers" });
        const owner = record.from?.name;
        if (owner && !seen.has(owner)) {
          seen.add(owner);
          next.add(owner);
        }
        if (depthRecords.length >= MAX_IMPACT_RECORDS) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    groups.push({ depth, records: sortRecords(dedupeRecords(depthRecords)) });
    if (truncated) break;
    frontier = [...next];
  }

  const relationCount = groups.reduce((sum, group) => sum + group.records.length, 0);
  recordCodeRelationQuery({
    relations: relationCount,
    savedRoundsEstimate: estimateSavedRounds(relationCount),
  });
  return {
    symbol,
    direction: "callers",
    requestedDepth,
    maxDepth,
    minConfidence,
    bestEffort: true,
    capped: requestedDepth > maxDepth,
    truncated,
    groups,
  };
}

function normalizeSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) throw new Error("symbol must be a non-empty string");
  return trimmed;
}

async function loadProjectSnapshot(
  rootDir: string,
  scope: string,
  opts: CodeRelationRuntimeOptions,
): Promise<ProjectSnapshot> {
  const listed = await listCodeFiles(rootDir, scope);
  const files: ProjectFile[] = [];
  for (const absPath of listed.files) {
    const source = await readFile(absPath, "utf8");
    const stat = await lstat(absPath);
    const path = rootRelativePath(rootDir, absPath);
    const parseOpts: ParseSourceOptions = { parseCache: opts.parseCache, stat };
    const symbols = await extractSymbols(absPath, source, parseOpts);
    files.push({
      path,
      absPath,
      source,
      symbols,
      calls: await extractCalls(absPath, path, source, symbols, parseOpts),
      imports: extractImports(path, source).map((entry) => resolveImport(rootDir, absPath, entry)),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated: listed.truncated };
}

async function listCodeFiles(
  rootDir: string,
  rawScope: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const start = resolveProjectPath(rootDir, rawScope);
  const files: string[] = [];
  let truncated = false;

  async function visit(path: string): Promise<void> {
    if (files.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
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
      await visit(resolve(path, entry.name));
      if (truncated) return;
    }
  }

  if (!existsSync(start)) return { files, truncated: false };
  await visit(start);
  files.sort();
  return { files, truncated };
}

async function extractCalls(
  absPath: string,
  relPath: string,
  source: string,
  symbols: CodeSymbol[],
  parseOpts: ParseSourceOptions = {},
): Promise<CallOccurrence[]> {
  const grammar = grammarForPath(absPath);
  if (!grammar) return [];
  const parsed = await parseSource(absPath, source, parseOpts);
  if (!parsed) return [];
  try {
    const sourceLines = source.split(/\r?\n/);
    const calls: CallOccurrence[] = [];
    walkCodeNodes(parsed.tree.rootNode, (node) => {
      if (!isIdentifierNode(node)) return;
      if (classifyIdentifierNode(node) !== "call") return;
      const line = node.startPosition.row + 1;
      const column = node.startPosition.column + 1;
      calls.push({
        file: relPath,
        line,
        column,
        name: node.text,
        snippet: sourceLines[node.startPosition.row] ?? "",
        owner: ownerRef(relPath, findInnermostSymbol(symbols, line, column)),
      });
    });
    calls.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
    return calls;
  } finally {
    parsed.tree.delete();
  }
}

function callerRecords(snapshot: ProjectSnapshot, symbol: string): CodeRelationRecord[] {
  const records: CodeRelationRecord[] = [];
  for (const file of snapshot.files) {
    for (const call of file.calls) {
      if (call.name !== symbol) continue;
      const confidence = confidenceForSymbolUse(snapshot, file, symbol);
      records.push({
        file: call.file,
        line: call.line,
        column: call.column,
        relation: "callers",
        symbol,
        confidence: confidence.tier,
        score: confidenceScore[confidence.tier],
        reason: confidence.reason,
        from: call.owner,
        to: bestDefinitionRef(snapshot, symbol, file.path),
        snippet: call.snippet,
      });
    }
  }
  return records;
}

function calleeRecords(snapshot: ProjectSnapshot, symbol: string): CodeRelationRecord[] {
  const records: CodeRelationRecord[] = [];
  for (const file of snapshot.files) {
    const ownerSymbols = file.symbols.filter((candidate) => symbolMatches(candidate, symbol));
    for (const owner of ownerSymbols) {
      for (const call of file.calls) {
        if (!isInsideSymbol(owner, call.line, call.column)) continue;
        const confidence = confidenceForSymbolUse(snapshot, file, call.name);
        records.push({
          file: call.file,
          line: call.line,
          column: call.column,
          relation: "callees",
          symbol: call.name,
          confidence: confidence.tier,
          score: confidenceScore[confidence.tier],
          reason: confidence.reason,
          from: ownerRef(file.path, owner),
          to: bestDefinitionRef(snapshot, call.name, file.path),
          snippet: call.snippet,
        });
      }
    }
  }
  return records;
}

function importsRecords(snapshot: ProjectSnapshot, symbol: string): CodeRelationRecord[] {
  const files = snapshot.files.filter((file) => fileMatchesSymbolQuery(file, symbol));
  const records: CodeRelationRecord[] = [];
  for (const file of files) {
    for (const item of file.imports) {
      records.push(importRecordToRelation(item, "imports", symbol, "EXTRACTED", "source import"));
    }
  }
  return records;
}

function importerRecords(snapshot: ProjectSnapshot, symbol: string): CodeRelationRecord[] {
  const records: CodeRelationRecord[] = [];
  for (const file of snapshot.files) {
    for (const item of file.imports) {
      const hit = importTargetsSymbol(snapshot, item, symbol);
      if (!hit) continue;
      records.push(importRecordToRelation(item, "importers", symbol, hit.tier, hit.reason));
    }
  }
  return records;
}

function importRecordToRelation(
  item: ImportRecord,
  relation: FindReferenceRelation,
  symbol: string,
  confidence: ConfidenceTier,
  reason: string,
): CodeRelationRecord {
  return {
    file: item.file,
    line: item.line,
    column: item.column,
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

function confidenceForSymbolUse(
  snapshot: ProjectSnapshot,
  file: ProjectFile,
  symbol: string,
): { tier: ConfidenceTier; reason: string } {
  if (file.symbols.some((candidate) => symbolMatches(candidate, symbol))) {
    return { tier: "EXTRACTED", reason: "same-file definition" };
  }
  for (const item of file.imports) {
    const hit = importTargetsSymbol(snapshot, item, symbol);
    if (hit) return hit;
  }
  if (snapshot.files.some((f) => f.symbols.some((candidate) => symbolMatches(candidate, symbol)))) {
    return { tier: "AMBIGUOUS", reason: "global fallback" };
  }
  return { tier: "AMBIGUOUS", reason: "unresolved dynamic or external symbol" };
}

function importTargetsSymbol(
  snapshot: ProjectSnapshot,
  item: ImportRecord,
  symbol: string,
): { tier: ConfidenceTier; reason: string } | null {
  if (item.names.includes(symbol)) {
    return { tier: "INFERRED", reason: "import-scoped binding" };
  }
  if (pathMatchesQuery(item.resolvedPath, symbol)) {
    return { tier: "EXTRACTED", reason: "resolved import path" };
  }
  if (!item.resolvedPath) return null;
  const imported = snapshot.files.find((file) => file.path === item.resolvedPath);
  if (imported?.symbols.some((candidate) => symbolMatches(candidate, symbol))) {
    return { tier: "INFERRED", reason: "resolved import source" };
  }
  return null;
}

function bestDefinitionRef(
  snapshot: ProjectSnapshot,
  symbol: string,
  preferredFile?: string,
): SymbolRef | undefined {
  const all = snapshot.files.flatMap((file) =>
    file.symbols
      .filter((candidate) => symbolMatches(candidate, symbol))
      .map((candidate) => ownerRef(file.path, candidate))
      .filter((candidate): candidate is SymbolRef => candidate !== undefined),
  );
  all.sort((a, b) => {
    const preferred = (a.file === preferredFile ? -1 : 0) + (b.file === preferredFile ? 1 : 0);
    return preferred || a.file.localeCompare(b.file) || a.line - b.line;
  });
  return all[0];
}

function extractImports(file: string, source: string): ImportRecord[] {
  const grammar = grammarForPath(file);
  if (!grammar) return [];
  if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") {
    return extractEcmaImports(file, source);
  }
  if (grammar === "python") return extractPythonImports(file, source);
  if (grammar === "java") return extractJavaImports(file, source);
  if (grammar === "go") return extractGoImports(file, source);
  if (grammar === "rust") return extractRustImports(file, source);
  return [];
}

function extractEcmaImports(file: string, source: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const importMatch = line.match(/^\s*import\s+(?:type\s+)?(?:(.*?)\s+from\s+)?["']([^"']+)["']/);
    if (importMatch?.[2]) {
      out.push({
        file,
        line: index + 1,
        column: line.search(/\S/) + 1,
        source: importMatch[2],
        names: namesFromEcmaClause(importMatch[1] ?? ""),
        raw: line,
      });
      return;
    }
    const exportMatch = line.match(
      /^\s*export\s+(?:type\s+)?(?:\*|(\{.*\})|[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/,
    );
    if (exportMatch?.[2]) {
      out.push({
        file,
        line: index + 1,
        column: line.search(/\S/) + 1,
        source: exportMatch[2],
        names: namesFromNamedList(exportMatch[1] ?? ""),
        raw: line,
      });
    }
  });
  return out;
}

function namesFromEcmaClause(clause: string): string[] {
  const trimmed = clause.trim();
  if (!trimmed) return [];
  const names: string[] = [];
  const named = trimmed.match(/\{([^}]+)\}/)?.[0] ?? "";
  if (named) names.push(...namesFromNamedList(named));
  const namespace = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace?.[1]) names.push(namespace[1]);
  const beforeComma = trimmed.split(",")[0]?.trim() ?? "";
  if (beforeComma && !beforeComma.startsWith("{") && !beforeComma.startsWith("*")) {
    names.push(beforeComma.replace(/^type\s+/, ""));
  }
  return uniqueStrings(names.filter(Boolean));
}

function namesFromNamedList(text: string): string[] {
  const body = text.replace(/[{}]/g, "");
  const names: string[] = [];
  for (const part of body.split(",")) {
    const cleaned = part.trim().replace(/^type\s+/, "");
    if (!cleaned) continue;
    const aliasParts = cleaned.split(/\s+as\s+/);
    for (const item of aliasParts) {
      const name = item.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return uniqueStrings(names);
}

function extractPythonImports(file: string, source: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const fromMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch?.[1] && fromMatch[2]) {
      out.push({
        file,
        line: index + 1,
        column: line.search(/\S/) + 1,
        source: fromMatch[1],
        names: namesFromCommaList(fromMatch[2]),
        raw: line,
      });
      return;
    }
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch?.[1]) {
      out.push({
        file,
        line: index + 1,
        column: line.search(/\S/) + 1,
        source: importMatch[1].split(",")[0]?.trim() ?? "",
        names: namesFromCommaList(importMatch[1]),
        raw: line,
      });
    }
  });
  return out;
}

function extractJavaImports(file: string, source: string): ImportRecord[] {
  return source.split(/\r?\n/).flatMap((line, index): ImportRecord[] => {
    const match = line.match(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/);
    if (!match?.[1]) return [];
    const parts = match[1].split(".");
    return [
      {
        file,
        line: index + 1,
        column: line.search(/\S/) + 1,
        source: match[1],
        names: uniqueStrings([parts[parts.length - 1] ?? ""]),
        raw: line,
      },
    ];
  });
}

function extractGoImports(file: string, source: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:import\s+)?(?:[A-Za-z_]\w*\s+)?["']([^"']+)["']/);
    if (!match?.[1]) return;
    out.push({
      file,
      line: index + 1,
      column: line.search(/\S/) + 1,
      source: match[1],
      names: [basename(match[1])],
      raw: line,
    });
  });
  return out;
}

function extractRustImports(file: string, source: string): ImportRecord[] {
  return source.split(/\r?\n/).flatMap((line, index): ImportRecord[] => {
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
        column: line.search(/\S/) + 1,
        source: match[1].trim(),
        names: uniqueStrings(names),
        raw: line,
      },
    ];
  });
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
      .filter((part) => /^[A-Za-z_]\w*$/.test(part)),
  );
}

function resolveImport(rootDir: string, fromAbsPath: string, item: ImportRecord): ImportRecord {
  const resolved = resolveImportPath(rootDir, fromAbsPath, item.source);
  return resolved ? { ...item, resolvedPath: rootRelativePath(rootDir, resolved) } : item;
}

function resolveImportPath(
  rootDir: string,
  fromAbsPath: string,
  source: string,
): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const base = resolve(fromAbsPath, "..", source);
  const candidates = candidateImportPaths(base);
  for (const candidate of candidates) {
    if (existsSync(candidate) && grammarForPath(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const indexFile = candidateImportPaths(resolve(candidate, "index")).find(
      (item) => existsSync(item) && grammarForPath(item),
    );
    if (indexFile) return indexFile;
  }
  const fallback = resolve(rootDir, source);
  return existsSync(fallback) && grammarForPath(fallback) ? fallback : undefined;
}

function candidateImportPaths(base: string): string[] {
  if (extname(base)) return [base];
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

function parseGitDiff(diff: string): Array<{ path: string; hunk: DiffHunk }> {
  const out: Array<{ path: string; hunk: DiffHunk }> = [];
  let currentPath: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? null : stripDiffPathPrefix(raw);
      continue;
    }
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match || !currentPath) continue;
    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    const oldLines = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newLines = Number.parseInt(match[4] ?? "1", 10);
    const lineStart = newLines === 0 ? oldStart : newStart;
    const lineEnd = newLines === 0 ? lineStart : newStart + newLines - 1;
    out.push({
      path: currentPath,
      hunk: { oldStart, oldLines, newStart, newLines, lineStart, lineEnd },
    });
  }
  return out;
}

function groupHunksByPath(hunks: Array<{ path: string; hunk: DiffHunk }>): Map<string, DiffHunk[]> {
  const byPath = new Map<string, DiffHunk[]>();
  for (const item of hunks) {
    const list = byPath.get(item.path) ?? [];
    list.push(item.hunk);
    byPath.set(item.path, list);
  }
  return byPath;
}

async function readGitDiff(rootDir: string, scope: DetectChangesScope): Promise<string> {
  if (scope === "all") {
    const [unstaged, staged] = await Promise.all([
      readGitDiff(rootDir, "unstaged"),
      readGitDiff(rootDir, "staged"),
    ]);
    return `${unstaged}\n${staged}`;
  }
  const args =
    scope === "staged"
      ? ["diff", "--cached", "--no-ext-diff", "--unified=0", "--"]
      : ["diff", "--no-ext-diff", "--unified=0", "--"];
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

function affectedSymbols(symbols: CodeSymbol[], hunks: DiffHunk[]): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    if (
      !hunks.some((hunk) => overlaps(symbol.line, symbol.endLine, hunk.lineStart, hunk.lineEnd))
    ) {
      continue;
    }
    const key = `${symbol.name}:${symbol.line}:${symbol.endLine}:${symbol.parent ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine: symbol.endLine,
      ...(symbol.parent ? { parent: symbol.parent } : {}),
    });
  }
  out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return out;
}

function stripDiffPathPrefix(raw: string): string {
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

function symbolMatches(symbol: CodeSymbol, query: string): boolean {
  return (
    symbol.name === query ||
    `${symbol.parent ?? ""}.${symbol.name}` === query ||
    `${symbol.parent ?? ""}#${symbol.name}` === query
  );
}

function fileMatchesSymbolQuery(file: ProjectFile, query: string): boolean {
  return (
    pathMatchesQuery(file.path, query) ||
    file.symbols.some((candidate) => symbolMatches(candidate, query))
  );
}

function pathMatchesQuery(path: string | undefined, query: string): boolean {
  if (!path) return false;
  const normalized = query.replaceAll("\\", "/").replace(/^\/+/, "");
  return path === normalized || path.endsWith(`/${normalized}`) || basename(path) === normalized;
}

function findInnermostSymbol(
  symbols: readonly CodeSymbol[],
  line: number,
  column: number,
): CodeSymbol | undefined {
  const candidates = symbols.filter((symbol) => isInsideSymbol(symbol, line, column));
  candidates.sort((a, b) => symbolSpanSize(a) - symbolSpanSize(b) || b.line - a.line);
  return candidates[0];
}

function isInsideSymbol(symbol: CodeSymbol, line: number, column: number): boolean {
  if (line < symbol.line || line > symbol.endLine) return false;
  if (line === symbol.line && column < symbol.column) return false;
  return !(line === symbol.endLine && column > symbol.endColumn);
}

function symbolSpanSize(symbol: CodeSymbol): number {
  return (symbol.endLine - symbol.line) * 10_000 + (symbol.endColumn - symbol.column);
}

function ownerRef(file: string, symbol: CodeSymbol | undefined): SymbolRef | undefined {
  if (!symbol) return undefined;
  return {
    name: symbol.name,
    file,
    line: symbol.line,
    kind: symbol.kind,
    ...(symbol.parent ? { parent: symbol.parent } : {}),
  };
}

function dedupeRecords(records: CodeRelationRecord[]): CodeRelationRecord[] {
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
      record.module ?? "",
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
      (a.module ?? "").localeCompare(b.module ?? ""),
  );
}

function rootRelativePath(rootDir: string, path: string): string {
  return relative(rootDir, path).split(sep).join("/") || ".";
}

function resolveProjectPath(rootDir: string, raw: string): string {
  const stripped = raw.replace(/^[/\\]+/, "");
  const resolved = resolve(rootDir, stripped.length === 0 ? "." : stripped);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${raw}`);
  }
  return resolved;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function estimateSavedRounds(size: number): number {
  if (size <= 0) return 0;
  return Math.max(1, Math.ceil(size / 5));
}

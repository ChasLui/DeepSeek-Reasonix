import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LRUCache } from "lru-cache";
import { Language, Parser, type Tree } from "web-tree-sitter";
import { nullPrototype } from "../utils/safe-object.js";

const localRequire = createRequire(import.meta.url);

export type GrammarName = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java";

const EXT_TO_GRAMMAR: Record<string, GrammarName> = nullPrototype({
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
});

export interface ParserOptions {
  grammarDir?: string;
}

export interface ParseCacheStat {
  mtimeMs: number;
  size: number;
}

export interface ParseCacheKey {
  absPath: string;
  mtimeMs: number;
  size: number;
  shaPrefix: string;
}

export interface ParseCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
}

export interface ParseTreeCacheOptions {
  maxEntries?: number;
  maxSizeBytes?: number;
}

export interface ParseSourceOptions extends ParserOptions {
  parseCache?: ParseTreeCache;
  stat?: ParseCacheStat;
  sha256?: string;
}

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<GrammarName, Promise<Language>>();
let resolvedGrammarDir: string | null = null;

const DEFAULT_PARSE_CACHE_ENTRIES = 100;
const DEFAULT_PARSE_CACHE_BYTES = 50 * 1024 * 1024;

interface StoredTree {
  key: ParseCacheKey;
  tree: Tree;
}

export function grammarForPath(filePath: string): GrammarName | null {
  const lower = filePath.toLowerCase();
  for (const ext of Object.keys(EXT_TO_GRAMMAR)) {
    if (lower.endsWith(ext)) return EXT_TO_GRAMMAR[ext]!;
  }
  return null;
}

export function setGrammarDir(dir: string): void {
  resolvedGrammarDir = dir;
  languageCache.clear();
}

export async function getParser(grammar: GrammarName, opts: ParserOptions = {}): Promise<Parser> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: (name: string) =>
        name === "web-tree-sitter.wasm"
          ? localRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")
          : name,
    });
  }
  await parserInitPromise;
  const language = await getLanguage(grammar, opts);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export async function getLanguage(
  grammar: GrammarName,
  opts: ParserOptions = {},
): Promise<Language> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: (name: string) =>
        name === "web-tree-sitter.wasm"
          ? localRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")
          : name,
    });
  }
  await parserInitPromise;
  return loadLanguage(grammar, opts);
}

export async function parseSource(
  filePath: string,
  source: string,
  opts: ParseSourceOptions = {},
): Promise<{ grammar: GrammarName; tree: Tree } | null> {
  const grammar = grammarForPath(filePath);
  if (!grammar) return null;
  const parseCache = opts.parseCache;
  const cacheKey =
    parseCache && opts.stat
      ? {
          absPath: resolve(filePath),
          mtimeMs: opts.stat.mtimeMs,
          size: opts.stat.size,
          shaPrefix: (opts.sha256 ?? hashSource(source)).slice(0, 16),
        }
      : null;
  if (cacheKey && parseCache) {
    const cached = parseCache.get(cacheKey);
    if (cached) return { grammar, tree: cached };
  }
  const parser = await getParser(grammar, opts);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) return null;
  if (cacheKey && parseCache) parseCache.set(cacheKey, tree);
  return { grammar, tree };
}

export class ParseTreeCache {
  private readonly cache: LRUCache<string, StoredTree>;
  private readonly keysByPath = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly disabled: boolean;

  constructor(opts: ParseTreeCacheOptions = {}) {
    this.disabled = process.env.REASONIX_PARSE_CACHE === "0";
    this.cache = new LRUCache<string, StoredTree>({
      max: opts.maxEntries ?? DEFAULT_PARSE_CACHE_ENTRIES,
      maxSize: opts.maxSizeBytes ?? DEFAULT_PARSE_CACHE_BYTES,
      sizeCalculation: (entry) => Math.max(1, entry.key.size),
      dispose: (entry, key, reason) => {
        this.removePathKey(entry.key.absPath, key);
        entry.tree.delete();
        if (reason === "evict" || reason === "expire") this.evictions++;
        if (process.env.REASONIX_CACHE_DEBUG === "1") {
          process.stderr.write(`parse-cache evict ${entry.key.absPath} (${reason})\n`);
        }
      },
    });
  }

  get(key: ParseCacheKey): Tree | null {
    if (this.disabled) return null;
    const stored = this.cache.get(parseCacheKey(key));
    if (!stored) {
      this.misses++;
      return null;
    }
    this.hits++;
    return stored.tree.copy();
  }

  set(key: ParseCacheKey, tree: Tree): void {
    if (this.disabled) return;
    const stringKey = parseCacheKey(key);
    this.cache.set(stringKey, { key, tree: tree.copy() });
    let keys = this.keysByPath.get(key.absPath);
    if (!keys) {
      keys = new Set();
      this.keysByPath.set(key.absPath, keys);
    }
    keys.add(stringKey);
  }

  invalidate(absPath: string): void {
    if (this.disabled) return;
    const keys = this.keysByPath.get(absPath);
    if (!keys) return;
    for (const key of keys) this.cache.delete(key);
    this.keysByPath.delete(absPath);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.keysByPath.clear();
  }

  stats(): ParseCacheStats {
    if (this.disabled) return { hits: 0, misses: 0, evictions: 0, entries: 0 };
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries: this.cache.size,
    };
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  private removePathKey(absPath: string, key: string): void {
    const keys = this.keysByPath.get(absPath);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.keysByPath.delete(absPath);
  }
}

function loadLanguage(grammar: GrammarName, opts: ParserOptions): Promise<Language> {
  const cached = languageCache.get(grammar);
  if (cached) return cached;
  const wasmPath = resolveGrammarPath(grammar, opts.grammarDir);
  const bytes = readFileSync(wasmPath);
  const promise = Language.load(new Uint8Array(bytes));
  languageCache.set(grammar, promise);
  return promise;
}

function parseCacheKey(key: ParseCacheKey): string {
  return `${key.absPath}|${key.mtimeMs}|${key.size}|${key.shaPrefix}`;
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function resolveGrammarPath(grammar: GrammarName, overrideDir?: string): string {
  const filename = `tree-sitter-${grammar}.wasm`;
  const candidates: string[] = [];
  if (overrideDir) candidates.push(resolve(overrideDir, filename));
  if (resolvedGrammarDir) candidates.push(resolve(resolvedGrammarDir, filename));
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", "grammars", filename));
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "grammars", filename));
  for (const pkg of DEV_PACKAGE_FOR_GRAMMAR[grammar]) {
    try {
      candidates.push(resolve(dirname(localRequire.resolve(`${pkg}/package.json`)), filename));
    } catch {
      /* dev-only grammar package not installed — fine in production builds */
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`tree-sitter grammar ${grammar} not found. Looked in: ${candidates.join(", ")}`);
}

const DEV_PACKAGE_FOR_GRAMMAR: Record<GrammarName, string[]> = nullPrototype({
  typescript: ["tree-sitter-typescript"],
  tsx: ["tree-sitter-typescript"],
  javascript: ["tree-sitter-javascript"],
  python: ["tree-sitter-python"],
  go: ["tree-sitter-go"],
  rust: ["tree-sitter-rust"],
  java: ["tree-sitter-java"],
});

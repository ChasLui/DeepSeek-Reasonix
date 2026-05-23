import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { segmentCjk } from "../../index/cjk/segment.js";
import { fuseRrf } from "../../index/hybrid/fuse.js";
import { Bm25Index } from "../../index/lexical/bm25.js";
import {
  type EmbedText,
  MemorySemanticStore,
  openMemorySemanticStore,
} from "../../index/memory-semantic.js";
import {
  appendAccess,
  computeDecayScore,
  forget,
  loadAccessStats,
  memoryRootFromHome,
  purge,
} from "../../memory/access.js";
import { countRecentObservationEvents } from "../../memory/observation.js";
import { listSessions, loadSessionMessages } from "../../memory/session.js";
import { type MemoryEntry, type MemoryScope, MemoryStore } from "../../memory/user.js";

export interface MemoryCommandOptions {
  homeDir?: string;
  projectRoot?: string;
  embedText?: EmbedText;
}

export interface MemorySearchOptions extends MemoryCommandOptions {
  hybrid?: boolean;
  topK?: number;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  score: number;
}

export interface MemorySearchResult {
  mode: "lexical-only" | "hybrid";
  hits: MemorySearchHit[];
  stale: boolean;
  semanticError?: string;
}

const DEFAULT_TOP_K = 8;
const INDEXED_SESSION_DOCS_FILE = "session-docs.json";

export async function memoryCommand(
  args: readonly string[],
  opts: MemoryCommandOptions = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "rebuild-index") {
    const result = await rebuildMemoryIndex(opts);
    console.log(`indexed ${result.entries} memories (lexical docs: ${result.lexicalDocs})`);
    if (result.semanticError) console.log(`semantic index skipped: ${result.semanticError}`);
    return;
  }
  if (subcommand === "search") {
    const parsed = parseSearchArgs(rest);
    const result = await searchMemory(parsed.query, { ...opts, ...parsed });
    if (parsed.json) {
      console.log(
        JSON.stringify({
          mode: result.mode,
          stale: result.stale,
          hits: result.hits.map((hit) => ({
            score: hit.score,
            scope: hit.entry.scope,
            name: hit.entry.name,
            type: hit.entry.type,
            description: hit.entry.description,
          })),
          ...(result.semanticError ? { semanticError: result.semanticError } : {}),
        }),
      );
      return;
    }
    if (result.stale) console.log("memory index is stale; run `reasonix memory rebuild-index`.");
    console.log(`mode: ${result.mode}`);
    for (const hit of result.hits) {
      console.log(
        `${hit.entry.scope}/${hit.entry.name}\t${hit.score.toFixed(4)}\t${hit.entry.description}`,
      );
    }
    if (result.semanticError) console.log(`semantic index skipped: ${result.semanticError}`);
    return;
  }
  if (subcommand === "stats") {
    const stats = memoryStats(opts);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  if (subcommand === "forget") {
    const parsed = parseForgetArgs(rest);
    const store = new MemoryStore({ homeDir: opts.homeDir, projectRoot: opts.projectRoot });
    if (parsed.purge) {
      const result = purge(store);
      console.log(`purged ${result.hardDeleted} memories from trash`);
      return;
    }
    const result = forget(store, parsed);
    for (const candidate of result.candidates) {
      console.log(
        [
          candidate.entry.name,
          candidate.entry.type,
          candidate.entry.priority ?? "medium",
          candidate.decayScore.toFixed(4),
          candidate.lastAccessedAt,
          candidate.action,
        ].join("\t"),
      );
    }
    console.log(`previewed=${result.previewed} softDeleted=${result.softDeleted}`);
    return;
  }
  console.log("Usage: reasonix memory <search|rebuild-index|stats|forget> ...");
}

export async function rebuildMemoryIndex(
  opts: MemoryCommandOptions = {},
): Promise<{ entries: number; lexicalDocs: number; semanticDocs: number; semanticError?: string }> {
  const store = new MemoryStore({ homeDir: opts.homeDir, projectRoot: opts.projectRoot });
  const paths = indexPaths(opts.homeDir);
  const entries = [...store.list(), ...loadIndexedSessionDocs(paths.sessionDocs)];
  const index = new Bm25Index();
  for (const entry of entries) {
    index.add(memoryDocId(entry), memoryTokens(entry));
  }

  mkdirSync(dirname(paths.lexical), { recursive: true });
  writeFileSync(paths.lexical, index.serialize(), "utf8");
  writeFileSync(paths.stale, "false\n", "utf8");

  let semanticDocs = 0;
  let semanticError: string | undefined;
  const semantic = new MemorySemanticStore(paths.semanticDir);
  try {
    await semantic.rebuild(
      entries.map((entry) => ({ docId: memoryDocId(entry), text: memoryText(entry) })),
      opts.embedText ? { embedText: opts.embedText } : {},
    );
    semanticDocs = semantic.size;
  } catch (err) {
    semanticError = err instanceof Error ? err.message : String(err);
  }

  return { entries: entries.length, lexicalDocs: index.size, semanticDocs, semanticError };
}

export async function indexImportedClaudeSessions(
  opts: MemoryCommandOptions = {},
): Promise<{ indexed: number; lexicalDocs: number; semanticError?: string }> {
  const paths = indexPaths(opts.homeDir);
  const docs = importedSessionDocs();
  mkdirSync(dirname(paths.sessionDocs), { recursive: true });
  writeFileSync(paths.sessionDocs, JSON.stringify(docs), "utf8");
  const rebuilt = await rebuildMemoryIndex(opts);
  return {
    indexed: docs.length,
    lexicalDocs: rebuilt.lexicalDocs,
    ...(rebuilt.semanticError ? { semanticError: rebuilt.semanticError } : {}),
  };
}

export async function searchMemory(
  query: string,
  opts: MemorySearchOptions = {},
): Promise<MemorySearchResult> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const store = new MemoryStore({ homeDir: opts.homeDir, projectRoot: opts.projectRoot });
  const paths = indexPaths(opts.homeDir);
  const entriesById = new Map(
    [...store.list(), ...loadIndexedSessionDocs(paths.sessionDocs)].map((entry) => [
      memoryDocId(entry),
      entry,
    ]),
  );
  const stale = isIndexStale(paths);
  const lexical = loadLexicalIndex(paths.lexical);
  const lexicalHits = lexical.search(segmentCjk(query), topK).map((hit) => ({
    docId: hit.docId,
    score: hit.score,
  }));

  let mode: MemorySearchResult["mode"] = "lexical-only";
  let fused = lexicalHits;
  let semanticError: string | undefined;
  const hybridEnabled = opts.hybrid === true && process.env.REASONIX_HYBRID_SEARCH !== "0";
  if (hybridEnabled) {
    mode = "hybrid";
    try {
      const semantic = await openMemorySemanticStore(paths.semanticDir);
      const semanticHits = await semantic.query(
        query,
        topK,
        opts.embedText ? { embedText: opts.embedText } : {},
      );
      fused = fuseRrf([
        lexicalHits,
        semanticHits.map((hit) => ({ docId: hit.docId, score: hit.score })),
      ]).slice(0, topK);
    } catch (err) {
      semanticError = err instanceof Error ? err.message : String(err);
      fused = lexicalHits;
    }
  }

  const hits: MemorySearchHit[] = [];
  for (const hit of fused) {
    const entry = entriesById.get(hit.docId);
    if (!entry) continue;
    hits.push({ entry, score: hit.score });
    appendAccess(entry.scope, entry.name, Date.now(), { homeDir: opts.homeDir });
  }

  return { mode, hits, stale, ...(semanticError ? { semanticError } : {}) };
}

export function memoryStats(opts: MemoryCommandOptions = {}): {
  entries: number;
  accessEvents: number;
  lexicalDocs: number;
  lexicalStale: boolean;
  semanticExists: boolean;
  indexedSessionDocs: number;
  observations24h: number;
  accessBytes: number;
  decay: { p50: number; p90: number };
} {
  const store = new MemoryStore({ homeDir: opts.homeDir, projectRoot: opts.projectRoot });
  const entries = store.list();
  const stats = loadAccessStats({ homeDir: opts.homeDir });
  const paths = indexPaths(opts.homeDir);
  const indexedSessionDocs = loadIndexedSessionDocs(paths.sessionDocs);
  const lexical = loadLexicalIndex(paths.lexical);
  const accessPath = join(memoryRootFromHome(opts.homeDir), ".access.jsonl");
  const scores = entries
    .map((entry) => computeDecayScore(entry, stats.get(`${entry.scope}/${entry.name}`)))
    .sort((a, b) => a - b);
  return {
    entries: entries.length,
    accessEvents: [...stats.values()].reduce((sum, stat) => sum + stat.accessCount, 0),
    lexicalDocs: lexical.size,
    lexicalStale: isIndexStale(paths),
    semanticExists: existsSync(join(paths.semanticDir, "embeddings.bin")),
    indexedSessionDocs: indexedSessionDocs.length,
    observations24h: countRecentObservationEvents(opts.homeDir),
    accessBytes: existsSync(accessPath) ? statSync(accessPath).size : 0,
    decay: {
      p50: percentile(scores, 0.5),
      p90: percentile(scores, 0.9),
    },
  };
}

function parseSearchArgs(args: readonly string[]): {
  query: string;
  hybrid: boolean;
  topK: number;
  json: boolean;
} {
  let hybrid = false;
  let json = false;
  let topK = DEFAULT_TOP_K;
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--hybrid") hybrid = true;
    else if (arg === "--json") json = true;
    else if (arg === "--top-k") topK = Number.parseInt(args[++i] ?? "", 10);
    else if (arg) queryParts.push(arg);
  }
  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("memory search requires a query");
  return { query, hybrid, topK: Number.isFinite(topK) ? topK : DEFAULT_TOP_K, json };
}

function parseForgetArgs(args: readonly string[]): {
  minScore: number;
  scope?: MemoryScope;
  dryRun: boolean;
  purge: boolean;
  halflifeDays?: number;
} {
  let minScore = 0.1;
  let scope: MemoryScope | undefined;
  let dryRun = true;
  let purgeMode = false;
  let yes = false;
  let halflifeDays: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--min-score") minScore = Number.parseFloat(args[++i] ?? "");
    else if (arg === "--scope") {
      const value = args[++i];
      if (value === "global" || value === "project") scope = value;
    } else if (arg === "--apply") dryRun = false;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--purge") purgeMode = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--halflife-days") halflifeDays = Number.parseFloat(args[++i] ?? "");
  }
  if (purgeMode && !yes) throw new Error("memory forget --purge requires --yes");
  return {
    minScore: Number.isFinite(minScore) ? minScore : 0.1,
    ...(scope ? { scope } : {}),
    dryRun,
    purge: purgeMode,
    ...(Number.isFinite(halflifeDays) ? { halflifeDays } : {}),
  };
}

function memoryDocId(entry: Pick<MemoryEntry, "scope" | "name">): string {
  return `${entry.scope}/${entry.name}`;
}

function memoryText(entry: Pick<MemoryEntry, "description" | "body">): string {
  return `${entry.description}\n${entry.body}`;
}

function memoryTokens(entry: Pick<MemoryEntry, "description" | "body">): string[] {
  return segmentCjk(memoryText(entry));
}

function indexPaths(homeDir: string = join(homedir(), ".reasonix")): {
  lexical: string;
  stale: string;
  semanticDir: string;
  sessionDocs: string;
} {
  const root = memoryRootFromHome(homeDir);
  return {
    lexical: join(root, ".index", "lexical.json"),
    stale: join(root, ".index", ".stale"),
    semanticDir: join(root, ".semantic"),
    sessionDocs: join(root, ".index", INDEXED_SESSION_DOCS_FILE),
  };
}

function loadLexicalIndex(path: string): Bm25Index {
  if (!existsSync(path)) return new Bm25Index();
  try {
    return Bm25Index.load(readFileSync(path, "utf8"));
  } catch {
    return new Bm25Index();
  }
}

function isIndexStale(paths: ReturnType<typeof indexPaths>): boolean {
  if (!existsSync(paths.lexical)) return true;
  if (!existsSync(paths.stale)) return false;
  return readFileSync(paths.stale, "utf8").trim() !== "false";
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const idx = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
  return values[idx] ?? 0;
}

function importedSessionDocs(): MemoryEntry[] {
  const docs: MemoryEntry[] = [];
  for (const session of listSessions({ sourceFilter: "claude-code" })) {
    const messages = loadSessionMessages(session.name);
    const body = messages
      .map((message) => {
        const content = typeof message.content === "string" ? message.content.trim() : "";
        return content ? `${message.role}: ${content}` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!body) continue;
    docs.push({
      scope: "global",
      type: "reference",
      name: importedSessionDocName(session.name),
      description: `Imported Claude Code session ${session.name}`,
      body,
      createdAt: session.mtime.toISOString().slice(0, 10),
    });
  }
  return docs;
}

function importedSessionDocName(sessionName: string): string {
  const hash = createHash("sha1").update(sessionName).digest("hex").slice(0, 12);
  return `claude_${hash}`;
}

function loadIndexedSessionDocs(path: string): MemoryEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMemoryEntry);
  } catch {
    return [];
  }
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MemoryEntry>;
  return (
    (entry.scope === "global" || entry.scope === "project") &&
    typeof entry.name === "string" &&
    typeof entry.type === "string" &&
    typeof entry.description === "string" &&
    typeof entry.body === "string" &&
    typeof entry.createdAt === "string"
  );
}

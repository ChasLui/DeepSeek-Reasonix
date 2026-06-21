import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Db, openIsolatedDb } from "../../storage/db.js";
import { CODE_GRAPH_VERSION } from "./types.js";

export type CodeGraphArtifactKind = "nodes" | "edges" | "bm25" | "files";

export interface CodeGraphArtifactRows {
  nodes: string;
  edges: string;
  bm25: string;
  files: string;
}

export interface CodeGraphArtifactStore {
  dbPath: string;
  read(): CodeGraphArtifactRows | null;
  write(rows: CodeGraphArtifactRows, graphHash: string): void;
  stats(): { artifactBytes: number } | null;
  close(): void;
}

const KINDS = ["nodes", "edges", "bm25", "files"] as const;
const CODE_GRAPH_INDEX_DIR = join(".reasonix", "index", "code-graph");

export function codeGraphArtifactDbPath(root: string): string {
  return join(root, CODE_GRAPH_INDEX_DIR, "artifacts.sqlite");
}

export function openCodeGraphArtifactStore(root: string): CodeGraphArtifactStore {
  const dbPath = codeGraphArtifactDbPath(root);
  const db = openIsolatedDb(dbPath, migrateCodeGraphArtifacts);
  return {
    dbPath,
    read: () => readRows(db),
    write: (rows, graphHash) => writeRows(db, rows, graphHash),
    stats: () => readStats(db),
    close: () => db.close(),
  };
}

export function codeGraphArtifactStoreExists(root: string): boolean {
  return existsSync(codeGraphArtifactDbPath(root));
}

function migrateCodeGraphArtifacts(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS code_graph_artifacts (kind TEXT PRIMARY KEY, version INTEGER NOT NULL, graph_hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
}

function readRows(db: Db): CodeGraphArtifactRows | null {
  const rows = db
    .prepare("SELECT kind, payload FROM code_graph_artifacts WHERE version = ? ORDER BY kind")
    .all(CODE_GRAPH_VERSION) as Array<{ kind: string; payload: string }>;
  if (rows.length === 0) return null;
  if (rows.length !== KINDS.length) return null;
  const byKind = new Map(rows.map((row) => [row.kind, row.payload]));
  const nodes = byKind.get("nodes");
  const edges = byKind.get("edges");
  const bm25 = byKind.get("bm25");
  const files = byKind.get("files");
  if (!nodes || !edges || !bm25 || !files) return null;
  return { nodes, edges, bm25, files };
}

function writeRows(db: Db, rows: CodeGraphArtifactRows, graphHash: string): void {
  const updatedAt = new Date().toISOString();
  db.tx(() => {
    for (const kind of KINDS) {
      db.prepare(
        "INSERT INTO code_graph_artifacts (kind, version, graph_hash, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind) DO UPDATE SET version = excluded.version, graph_hash = excluded.graph_hash, payload = excluded.payload, updated_at = excluded.updated_at",
      ).run(kind, CODE_GRAPH_VERSION, graphHash, rows[kind], updatedAt);
    }
  });
}

function readStats(db: Db): { artifactBytes: number } | null {
  const row = db
    .prepare(
      "SELECT COUNT(*) count, SUM(LENGTH(payload)) bytes FROM code_graph_artifacts WHERE version = ?",
    )
    .get(CODE_GRAPH_VERSION) as { count?: number; bytes?: number } | undefined;
  if (!row || Number(row.count) !== KINDS.length) return null;
  return { artifactBytes: Number(row.bytes ?? 0) };
}

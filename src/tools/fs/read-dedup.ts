/** Session-scoped read-dedup: lets read_file stub an unchanged re-read instead
 * of re-dumping. Instance-per-loop (isolation), content-hashed (not mtime), log-aware. */

import { createHash } from "node:crypto";

/** File identity + freshness, all from the same opened fd's stat. */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
}

interface DedupEntry extends FileIdentity {
  sha256: string;
  lines: number;
  bytes: number;
  logToken: number;
}

export interface ReadDedupStats {
  hits: number;
  dumpsSaved: number;
  bytesSaved: number;
}

/** sha256 of the exact bytes read — the same buffer read_file will emit. */
export function hashContent(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Params that fully determine read_file's emitted view. Same signature + same
 * content hash ⟹ byte-identical body (body is a pure fn of raw + these). */
export interface EmittedView {
  /** Resolved output mode after read_file's branch selection. */
  mode: "range" | "head" | "tail" | "full" | "outline";
  /** Normalized range "A-B" (raw arg, pre-clamp — clamp is deterministic given content). */
  range?: string;
  head?: number;
  tail?: number;
  /** Whether aggressive stripping actually applies (level=aggressive AND supported). */
  aggressive: boolean;
  /** Per-toolset outline threshold — changes the full-vs-outline boundary. */
  outlineThreshold: number;
}

/** Stable string key fragment for an emitted view. Order-fixed, no dynamic fields. */
export function emittedViewSignature(v: EmittedView): string {
  return [
    v.mode,
    v.range ?? "",
    v.head ?? "",
    v.tail ?? "",
    v.aggressive ? "agg" : "min",
    v.outlineThreshold,
  ].join("|");
}

/** Key = lexical abs path + view. Path-keyed (not inode-keyed) because the body
 * depends on path (subdir REASONIX.md, `rel` markers), so inode aliases must NOT
 * share a stub; symlink-retarget (same path) is caught by dev/ino in `lookup`. */
export function dedupKey(absPath: string, viewSig: string): string {
  return `${absPath}\n${viewSig}`;
}

export class ReadDedupState {
  private readonly entries = new Map<string, DedupEntry>();
  private readonly inflight = new Set<string>();
  /** logTokens whose emitted output is still intact in the active log. */
  private readonly liveTokens = new Set<number>();
  private nextToken = 1;
  private stats: ReadDedupStats = { hits: 0, dumpsSaved: 0, bytesSaved: 0 };

  /** Claim a key. false ⟹ another in-flight read owns it: caller must force a
   * miss + skip record (concurrency determinism). Pair `true` with endRead in finally. */
  beginRead(key: string): boolean {
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  endRead(key: string): void {
    this.inflight.delete(key);
  }

  /** Returns the live entry iff identity + content hash + log-liveness all match
   * — i.e. it is safe to emit a "content still above" stub. */
  lookup(key: string, id: FileIdentity, sha256: string): DedupEntry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.dev !== id.dev || e.ino !== id.ino || e.size !== id.size || e.mtimeMs !== id.mtimeMs)
      return null;
    if (e.sha256 !== sha256) return null;
    if (!this.liveTokens.has(e.logToken)) return null;
    return e;
  }

  /** Record a freshly-dumped read. Returns the logToken (live until the next
   * `invalidateAll`); callers may ignore it. */
  record(key: string, id: FileIdentity, sha256: string, lines: number, bytes: number): number {
    const logToken = this.nextToken++;
    this.entries.set(key, { ...id, sha256, lines, bytes, logToken });
    this.liveTokens.add(logToken);
    return logToken;
  }

  /** Count a stub emission. */
  markHit(bytesSaved: number): void {
    this.stats.hits++;
    this.stats.dumpsSaved++;
    this.stats.bytesSaved += bytesSaved;
  }

  /** Any compaction (fold / heal / shrink) replaced the active log — every
   * prior output a stub could point at is gone. Drop the liveness set AND the
   * entries map (entries are now unreachable; clearing bounds memory). */
  invalidateAll(): void {
    this.liveTokens.clear();
    this.entries.clear();
  }

  getStats(): ReadDedupStats {
    return { ...this.stats };
  }

  /** New session / resume — wipe everything for THIS instance only. */
  reset(): void {
    this.entries.clear();
    this.inflight.clear();
    this.liveTokens.clear();
    this.stats = { hits: 0, dumpsSaved: 0, bytesSaved: 0 };
  }
}

import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PendingPromptChanges, PromptSnapshot } from "../cache/prompt-fingerprint.js";
import { PromptFingerprint } from "../cache/prompt-fingerprint.js";
import { noFollowFlag } from "../tools/fs/gate.js";
import type { ChatMessage } from "../types.js";
import { sha256Prefix } from "../utils/sha256.js";
import { type SecretRedactor, defaultRedactor } from "./secret-redactor.js";

export interface CacheBreakReport {
  timestamp: number;
  callCount: number;
  prevHitTokens: number;
  hitTokens: number;
  dropTokens: number;
  reason: string;
  reasonCategory: CacheBreakReasonCategory;
  diffPatchPath?: string;
  writeError?: string;
  epochLabel?: string;
}

export type CacheBreakReasonCategory =
  | "best-effort-miss"
  | "epoch-leak"
  | "older-miss"
  | "recent-miss"
  | "server-side"
  | "system"
  | "tools"
  | "ttl-1h"
  | "ttl-5min"
  | "unknown";

export interface PromptCacheStats {
  enabled: boolean;
  hitTokens: number;
  missTokens: number;
  hitRatio: number;
  breaks: number;
  writeFailures: number;
  recentBreakCategories?: ReadonlyArray<CacheBreakReasonCategory>;
  lastBreakReason?: string;
}

export interface PromptCacheMonitorOptions {
  tmpDir?: string;
  minDropTokens?: number;
  dropRatio?: number;
  secretRedactor?: SecretRedactor;
}

export interface PromptCacheUsage {
  promptCacheHitTokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  hit?: number | null;
  promptCacheMissTokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
}

interface PendingEpoch {
  label: string;
  added: string[];
  removed: string[];
}

const DEFAULT_MIN_DROP_TOKENS = 2000;
const DEFAULT_DROP_RATIO = 0.05;
const MAX_BREAK_HISTORY = 100;
const RECENT_MISS_CUTOFF_MS = 10 * 60 * 1000;
const DIFF_WRITE_MAX_ATTEMPTS = 3;

const EMPTY_CHANGES: PendingPromptChanges = {
  systemChanged: false,
  toolsChanged: false,
  changedToolNames: [],
  addedToolNames: [],
  removedToolNames: [],
  systemCharDelta: 0,
};

export class PromptCacheMonitor {
  private readonly tmpDir: string;
  private readonly minDropTokens: number;
  private readonly dropRatio: number;
  private readonly secretRedactor: SecretRedactor;
  private readonly enabled: boolean;
  private readonly explicitDiffDir: boolean;
  private readonly fingerprint = new PromptFingerprint();
  private prevSnapshot: PromptSnapshot | null = null;
  private currentSnapshot: PromptSnapshot | null = null;
  private prevHitTokens: number | null = null;
  private pendingChanges: PendingPromptChanges | null = null;
  private pendingEpoch: PendingEpoch | null = null;
  private readonly breakHistory: CacheBreakReport[] = [];
  private callCount = 0;
  private hitTokens = 0;
  private missTokens = 0;
  private writeFailures = 0;
  /** Wall-clock of the last recordAfterCall — fallback reason uses (now - lastCallAt) as the
   * "no observed assistant response since" age, since ChatMessage carries no timestamps. */
  private lastCallAt: number | null = null;

  constructor(opts: PromptCacheMonitorOptions = {}) {
    this.explicitDiffDir =
      opts.tmpDir !== undefined || process.env.REASONIX_CACHE_BREAK_DIFF_DIR !== undefined;
    this.tmpDir =
      opts.tmpDir ??
      process.env.REASONIX_CACHE_BREAK_DIFF_DIR ??
      join(homedir(), ".reasonix", "tmp");
    this.minDropTokens = opts.minDropTokens ?? DEFAULT_MIN_DROP_TOKENS;
    this.dropRatio = opts.dropRatio ?? DEFAULT_DROP_RATIO;
    this.secretRedactor = opts.secretRedactor ?? defaultRedactor;
    this.enabled = process.env.REASONIX_PROMPT_CACHE_MONITOR !== "0";
  }

  recordBeforeCall(snapshot: PromptSnapshot): void {
    if (!this.enabled) return;
    const safeSnapshot = cloneSnapshot(snapshot);
    this.currentSnapshot = safeSnapshot;
    this.pendingChanges = this.fingerprint.diff(this.prevSnapshot, safeSnapshot);
    this.callCount++;
  }

  recordAfterCall(
    usage: PromptCacheUsage | undefined | null,
    messages: readonly ChatMessage[],
  ): void {
    if (!this.enabled) return;
    const now = Date.now();
    const age = this.lastCallAt !== null ? now - this.lastCallAt : null;
    const hit = readHitTokens(usage);
    const miss = readMissTokens(usage);
    if (hit === null) {
      this.commitSnapshot();
      this.clearPending();
      return;
    }
    this.hitTokens += hit;
    if (miss !== null) this.missTokens += miss;
    if (this.prevHitTokens === null) {
      this.prevHitTokens = hit;
      this.lastCallAt = now;
      this.commitSnapshot();
      this.clearPending();
      return;
    }

    const dropTokens = this.prevHitTokens - hit;
    const ratio = this.prevHitTokens > 0 ? dropTokens / this.prevHitTokens : 0;
    if (dropTokens <= this.minDropTokens || ratio <= this.dropRatio) {
      this.prevHitTokens = hit;
      this.lastCallAt = now;
      this.commitSnapshot();
      this.clearPending();
      return;
    }

    const changes = this.pendingChanges ?? EMPTY_CHANGES;
    if (this.isPreciseEpochMatch(changes)) {
      this.prevHitTokens = hit;
      this.lastCallAt = now;
      this.commitSnapshot();
      this.clearPending();
      return;
    }

    const reason = this.reasonFor(changes, age);
    const report: CacheBreakReport = {
      timestamp: now,
      callCount: this.callCount,
      prevHitTokens: this.prevHitTokens,
      hitTokens: hit,
      dropTokens,
      reason: reason.text,
      reasonCategory: reason.category,
      epochLabel: this.pendingEpoch?.label,
    };
    const diffPatch = this.writeDiffPatch(report, changes, messages);
    if (diffPatch.diffPatchPath) report.diffPatchPath = diffPatch.diffPatchPath;
    if (diffPatch.writeError) report.writeError = diffPatch.writeError;
    this.breakHistory.push(report);
    if (this.breakHistory.length > MAX_BREAK_HISTORY) this.breakHistory.shift();
    if (this.shouldEmitBreakWarning()) {
      process.stderr.write(
        `[PROMPT CACHE BREAK] ${report.reason} [call #${report.callCount}, hit: ${report.prevHitTokens}->${report.hitTokens}]${report.diffPatchPath ? ` diff: ${report.diffPatchPath}` : ""}\n`,
      );
    }

    this.prevHitTokens = hit;
    this.lastCallAt = now;
    this.commitSnapshot();
    this.clearPending();
  }

  recordEpochEvent(
    label: string,
    payload?: { added?: readonly string[]; removed?: readonly string[] },
  ): void {
    if (!this.enabled) return;
    const nextAdded = [...(payload?.added ?? [])];
    const nextRemoved = [...(payload?.removed ?? [])];
    if (this.pendingEpoch && this.pendingEpoch.label === label) {
      // Merge — multiple addTool calls in one turn must all be folded into a single epoch.
      this.pendingEpoch = {
        label,
        added: uniqueSort([...this.pendingEpoch.added, ...nextAdded]),
        removed: uniqueSort([...this.pendingEpoch.removed, ...nextRemoved]),
      };
      return;
    }
    this.pendingEpoch = {
      label,
      added: uniqueSort(nextAdded),
      removed: uniqueSort(nextRemoved),
    };
  }

  resetBaseline(): void {
    if (!this.enabled) return;
    this.prevSnapshot = null;
    this.currentSnapshot = null;
    this.prevHitTokens = null;
    this.pendingChanges = null;
    this.pendingEpoch = null;
    this.lastCallAt = null;
    this.callCount = 0;
  }

  getReport(limit = 100): CacheBreakReport[] {
    if (!this.enabled) return [];
    return this.breakHistory.slice(-limit).map((r) => ({ ...r }));
  }

  stats(): PromptCacheStats {
    const denom = this.hitTokens + this.missTokens;
    const base = {
      enabled: this.enabled,
      hitTokens: this.hitTokens,
      missTokens: this.missTokens,
      hitRatio: denom > 0 ? this.hitTokens / denom : 0,
      breaks: this.enabled ? this.breakHistory.length : 0,
      writeFailures: this.writeFailures,
      recentBreakCategories: this.breakHistory.slice(-5).map((r) => r.reasonCategory),
    };
    const last = this.breakHistory[this.breakHistory.length - 1];
    return last ? { ...base, lastBreakReason: last.reason } : base;
  }

  private commitSnapshot(): void {
    this.prevSnapshot = this.currentSnapshot
      ? cloneSnapshot(this.currentSnapshot)
      : this.prevSnapshot;
  }

  private clearPending(): void {
    this.pendingChanges = null;
    this.pendingEpoch = null;
  }

  private isPreciseEpochMatch(changes: PendingPromptChanges): boolean {
    if (!this.pendingEpoch) return false;
    if (changes.systemChanged) return false;
    if (changes.changedToolNames.length > 0) return false;
    // Pure tool-order drift: toolsHash diverged but no add/remove/change names.
    // C-INV-8 — any byte drift not explained by epoch payload must still report.
    if (
      changes.toolsChanged &&
      changes.addedToolNames.length === 0 &&
      changes.removedToolNames.length === 0
    ) {
      return false;
    }
    return (
      isSubset(changes.addedToolNames, this.pendingEpoch.added) &&
      isSubset(changes.removedToolNames, this.pendingEpoch.removed)
    );
  }

  private reasonFor(
    changes: PendingPromptChanges,
    age: number | null,
  ): { text: string; category: CacheBreakReport["reasonCategory"] } {
    if (
      changes.systemChanged ||
      changes.addedToolNames.length > 0 ||
      changes.removedToolNames.length > 0 ||
      changes.changedToolNames.length > 0
    ) {
      const pieces: string[] = [];
      if (changes.systemChanged)
        pieces.push(`system changed (${formatDelta(changes.systemCharDelta)} chars)`);
      if (changes.addedToolNames.length > 0)
        pieces.push(`tools added: ${changes.addedToolNames.join(", ")}`);
      if (changes.removedToolNames.length > 0)
        pieces.push(`tools removed: ${changes.removedToolNames.join(", ")}`);
      if (changes.changedToolNames.length > 0)
        pieces.push(`tools changed: ${changes.changedToolNames.join(", ")}`);
      if (this.pendingEpoch) {
        return {
          text: `epoch ${this.pendingEpoch.label} plus extra prompt drift: ${pieces.join("; ")}`,
          category: "epoch-leak",
        };
      }
      return {
        text: pieces.join("; "),
        category: changes.systemChanged ? "system" : "tools",
      };
    }
    return fallbackReason(age);
  }

  private writeDiffPatch(
    report: CacheBreakReport,
    changes: PendingPromptChanges,
    messages: readonly ChatMessage[],
  ): { diffPatchPath?: string; writeError?: string } {
    if (process.env.REASONIX_CACHE_BREAK_DIFF === "0") return {};
    if (isTestProcess() && !this.explicitDiffDir) return {};
    const snapshot = this.currentSnapshot;
    if (!snapshot) return {};
    const raw = [
      "--- prompt-cache-before",
      "+++ prompt-cache-after",
      "@@ prompt cache break @@",
      `-hit_tokens=${report.prevHitTokens}`,
      `+hit_tokens=${report.hitTokens}`,
      `+drop_tokens=${report.dropTokens}`,
      `+reason=${report.reason}`,
      `+epoch=${report.epochLabel ?? ""}`,
      `+changes=${JSON.stringify(changes)}`,
      `+snapshot=${JSON.stringify(snapshotToJson(snapshot))}`,
      `+messages=${JSON.stringify(messages)}`,
      "",
    ].join("\n");
    const payload = this.secretRedactor(sanitizePromptCachePaths(raw));
    try {
      mkdirSync(dirname(this.tmpDir), { recursive: true, mode: 0o700 });
      try {
        mkdirSync(this.tmpDir, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    } catch (err) {
      return this.recordWriteFailure(err, 1);
    }
    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= DIFF_WRITE_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      const id = randomBytes(6).toString("hex");
      const path = join(this.tmpDir, `cache-break-${id}.diff`);
      try {
        writeFileExclusive(path, payload);
        return { diffPatchPath: sanitizePathLabel(path) };
      } catch (err) {
        lastError = err;
        if (!isDiffWriteRetryable(err)) return this.recordWriteFailure(err, attempt);
      }
    }
    return this.recordWriteFailure(lastError, attempts);
  }

  private recordWriteFailure(err: unknown, attempts: number): { writeError: string } {
    this.writeFailures++;
    const writeError = formatWriteError(err, attempts);
    console.warn(`[PROMPT CACHE BREAK] diff patch write failed: ${writeError}`);
    return { writeError };
  }

  private shouldEmitBreakWarning(): boolean {
    return !isTestProcess() || this.explicitDiffDir;
  }
}

function readHitTokens(usage: PromptCacheUsage | undefined | null): number | null {
  if (!usage) return null;
  return readNumber(usage.promptCacheHitTokens ?? usage.prompt_cache_hit_tokens ?? usage.hit);
}

function readMissTokens(usage: PromptCacheUsage | undefined | null): number | null {
  if (!usage) return null;
  return readNumber(usage.promptCacheMissTokens ?? usage.prompt_cache_miss_tokens);
}

function readNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cloneSnapshot(snapshot: PromptSnapshot): PromptSnapshot {
  return {
    ...snapshot,
    perToolHashes: new Map(snapshot.perToolHashes),
  };
}

function snapshotToJson(snapshot: PromptSnapshot): Record<string, unknown> {
  return {
    ...snapshot,
    perToolHashes: Object.fromEntries(snapshot.perToolHashes),
  };
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

function uniqueSort(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function formatDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

export function classifyPromptCacheFallback(age: number | null): {
  text: string;
  category: CacheBreakReasonCategory;
} {
  if (age === null) {
    return {
      text: "best-effort miss (no prior call baseline; DeepSeek does not guarantee 100% cache hit)",
      category: "best-effort-miss",
    };
  }
  if (age >= RECENT_MISS_CUTOFF_MS) {
    return {
      text: "older miss (≥ 10 min, possible TTL expiry; DeepSeek TTL is non-deterministic 'hours to days')",
      category: "older-miss",
    };
  }
  return {
    text: "recent miss (< 10 min, likely server-side eviction within DeepSeek best-effort cache window)",
    category: "recent-miss",
  };
}

export function sanitizePromptCachePaths(text: string): string {
  const home = homedir();
  const homeReplaced = text.replaceAll(home, "~");
  const windowsReplaced = homeReplaced.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[WIN_PATH]");
  const tildeReplaced = windowsReplaced.replace(
    /(?:^|(?<=[\s'"=`(,;<>]))(~\/[A-Za-z0-9._~@%+=-]+(?:\/[A-Za-z0-9._~@%+=-]+)+)/g,
    (_match, path: string) => sanitizePathLabel(path),
  );
  // Match absolute POSIX paths only at non-identifier boundaries; URL host ends with a
  // letter/digit so `https://h.com/api/v1` never matches (the `/` after `h.com` has `m`
  // before it, not whitespace/punct/start-of-line). Stays a single regex so chains stay simple.
  return tildeReplaced.replace(
    /(?:^|(?<=[\s'"=`(,;<>]))(\/[A-Za-z0-9._@%+=-][A-Za-z0-9._~@%+=-]*(?:\/[A-Za-z0-9._~@%+=-]+)+)/g,
    (_match, path: string) => sanitizePathLabel(path),
  );
}

function sanitizePathLabel(path: string): string {
  if (path.startsWith("~/")) {
    const firstSegment = path.slice(2).split("/")[0] ?? "path";
    return `~/${firstSegment}.sha=${sha256Prefix(path, 8)}`;
  }
  return `${basename(path)}.sha=${sha256Prefix(path, 8)}`;
}

function fallbackReason(age: number | null): {
  text: string;
  category: CacheBreakReasonCategory;
} {
  return classifyPromptCacheFallback(age);
}

function writeFileExclusive(path: string, payload: string): void {
  const nf = noFollowFlag();
  const flags =
    nf === undefined ? "wx" : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nf;
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, payload);
  } finally {
    closeSync(fd);
  }
}

function isDiffWriteRetryable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "ELOOP";
}

function formatWriteError(err: unknown, attempts: number): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const code = e?.code ?? "UNKNOWN";
  const message = e?.message ?? String(err);
  return `${code} after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${message}`;
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST_WORKER_ID !== undefined;
}

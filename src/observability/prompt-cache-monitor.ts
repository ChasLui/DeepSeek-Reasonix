import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  reasonCategory:
    | "system"
    | "tools"
    | "epoch-leak"
    | "ttl-1h"
    | "ttl-5min"
    | "server-side"
    | "unknown";
  diffPatchPath?: string;
  epochLabel?: string;
}

export interface PromptCacheStats {
  enabled: boolean;
  hitTokens: number;
  missTokens: number;
  hitRatio: number;
  breaks: number;
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
const TTL_1H_MS = 60 * 60 * 1000;
const TTL_5M_MS = 5 * 60 * 1000;

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
    const diffPatchPath = this.writeDiffPatch(report, changes, messages);
    if (diffPatchPath) report.diffPatchPath = diffPatchPath;
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
  ): string | undefined {
    if (process.env.REASONIX_CACHE_BREAK_DIFF === "0") return undefined;
    if (isTestProcess() && !this.explicitDiffDir) return undefined;
    const snapshot = this.currentSnapshot;
    if (!snapshot) return undefined;
    try {
      mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
      const id = randomBytes(6).toString("hex");
      const path = join(this.tmpDir, `cache-break-${id}.diff`);
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
      const payload = this.secretRedactor(sanitizePaths(raw));
      const nf = noFollowFlag() ?? 0;
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nf;
      const fd = openSync(path, flags, 0o600);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return sanitizePathLabel(path);
    } catch {
      return undefined;
    }
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

function fallbackReason(age: number | null): {
  text: string;
  category: CacheBreakReport["reasonCategory"];
} {
  if (age === null) return { text: "unknown cause (prompt unchanged)", category: "unknown" };
  if (age > TTL_1H_MS) {
    return {
      text: "possible 1h TTL expiry (prompt unchanged)",
      category: "ttl-1h",
    };
  }
  if (age > TTL_5M_MS) {
    return {
      text: "possible 5min TTL expiry (prompt unchanged)",
      category: "ttl-5min",
    };
  }
  return {
    text: "likely server-side (prompt unchanged)",
    category: "server-side",
  };
}

function sanitizePaths(text: string): string {
  const home = homedir();
  const homeReplaced = text.replaceAll(home, "~");
  // Match absolute POSIX paths only at non-identifier boundaries; URL host ends with a
  // letter/digit so `https://h.com/api/v1` never matches (the `/` after `h.com` has `m`
  // before it, not whitespace/punct/start-of-line). Stays a single regex so chains stay simple.
  return homeReplaced.replace(
    /(?:^|(?<=[\s'"=`(,;<>]))(\/[A-Za-z0-9._@%+=-][A-Za-z0-9._~@%+=-]*(?:\/[A-Za-z0-9._~@%+=-]+)+)/g,
    (_match, path: string) => sanitizePathLabel(path),
  );
}

function sanitizePathLabel(path: string): string {
  if (path.startsWith("~")) return path;
  return `${basename(path)}.sha=${sha256Prefix(path, 8)}`;
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST_WORKER_ID !== undefined;
}

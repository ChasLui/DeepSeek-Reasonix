import { EventEmitter } from "node:events";
import type { RateLimitConfig } from "../config.js";
import type { RateLimitAcquiredPayload, RateLimitQueuedPayload } from "../core/events.js";
import { nullPrototype } from "../utils/safe-object.js";
import { RateLimitTimeoutError } from "./errors.js";

export type RateLimitBucketName = "pro" | "flash" | "default";
export type RateLimitCapSource = "env" | "config" | "default";
export type TokenState = "acquired" | "fetching" | "streaming" | "released";
export type RateLimitEmitterEvent = RateLimitQueuedPayload | RateLimitAcquiredPayload;

export interface ConcurrencyStats {
  inUse: number;
  cap: number;
  initialCap: number;
  queued: number;
  recent429: number;
  degradedAt: number | null;
  lastRestoreAt: number | null;
  adaptive: boolean;
}

export interface ConcurrencyCapSetting {
  bucket: RateLimitBucketName;
  model: string;
  cap: number;
  upstreamCap: number;
  source: RateLimitCapSource;
  requestedCap?: number;
  manuallyNarrowed: boolean;
}

export interface ResolvedConcurrencySettings {
  caps: Record<RateLimitBucketName, ConcurrencyCapSetting>;
  adaptive: boolean;
  adaptiveSource: RateLimitCapSource;
  queueGiveupMs: number;
  queueHintMs: number;
  restoreIntervalMs: number;
  throttleWindowMs: number;
  queueMaxDepth: number;
}

export interface ConcurrencyBucketOptions {
  settings?: ResolvedConcurrencySettings;
  rateLimit?: RateLimitConfig;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

interface ModelState {
  cap: number;
  initialCap: number;
  upstreamCap: number;
  degradedAt: number | null;
  lastRestoreAt: number | null;
  lastNote429At: number | null;
  recent429At: number[];
  note429TimesIn5s: number;
}

interface QueueEntry {
  model: string;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_QUEUE_GIVEUP_MS = 60_000;
const DEFAULT_QUEUE_HINT_MS = 2000;
const DEFAULT_RESTORE_INTERVAL_MS = 60_000;
const DEFAULT_THROTTLE_WINDOW_MS = 5000;
const DEFAULT_QUEUE_MAX_DEPTH = 256;

export const UPSTREAM_CONCURRENCY_CAPS: Record<RateLimitBucketName, number> = nullPrototype({
  pro: 500,
  flash: 2500,
  default: 128,
});

export const CONCURRENCY_MODEL_IDS: Record<RateLimitBucketName, string> = nullPrototype({
  pro: "deepseek-v4-pro",
  flash: "deepseek-v4-flash",
  default: "default",
});

const CAP_ENV: Record<RateLimitBucketName, string> = nullPrototype({
  pro: "REASONIX_CONCURRENCY_PRO",
  flash: "REASONIX_CONCURRENCY_FLASH",
  default: "REASONIX_CONCURRENCY_DEFAULT",
});

export class RateLimitEventEmitter {
  private readonly emitter = new EventEmitter();

  on<T extends RateLimitEmitterEvent["type"]>(
    type: T,
    listener: (event: Extract<RateLimitEmitterEvent, { type: T }>) => void,
  ): () => void {
    const wrapped = listener as (event: RateLimitEmitterEvent) => void;
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }

  emit(event: RateLimitEmitterEvent): void {
    this.emitter.emit(event.type, event);
  }
}

export class ConcurrencyToken {
  private stateValue: TokenState = "acquired";
  private released = false;

  constructor(
    private readonly bucket: ConcurrencyBucket,
    private readonly bucketName: RateLimitBucketName,
    readonly model: string,
    readonly queuedMs: number,
  ) {}

  get state(): TokenState {
    return this.stateValue;
  }

  transitionTo(next: Exclude<TokenState, "acquired">): void {
    if (next === "released") {
      this.release();
      return;
    }
    const allowed: Record<TokenState, TokenState[]> = {
      acquired: ["fetching", "released"],
      fetching: ["streaming", "released"],
      streaming: ["released"],
      released: [],
    };
    if (!allowed[this.stateValue].includes(next)) {
      throw new Error(`invalid token transition ${this.stateValue} -> ${next}`);
    }
    this.stateValue = next;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.stateValue = "released";
    this.bucket.release(this.bucketName);
  }
}

class Semaphore {
  private queue: QueueEntry[] = [];
  private inUseCount = 0;

  constructor(
    private capValue: number,
    private readonly queueMaxDepth: number,
    private readonly now: () => number,
    private readonly emitQueued: (model: string, depth: number, estimatedWaitMs: number) => void,
    private readonly emitAcquired: (model: string, queuedMs: number) => void,
  ) {}

  get cap(): number {
    return this.capValue;
  }

  get inUse(): number {
    return this.inUseCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  setCap(next: number): void {
    this.capValue = Math.max(1, next);
    this.drain();
  }

  acquire(
    model: string,
    signal: AbortSignal | undefined,
    giveupMs: number,
    hintMs: number,
  ): Promise<number> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.inUseCount < this.capValue) {
      this.inUseCount++;
      this.emitAcquired(model, 0);
      return Promise.resolve(0);
    }
    if (this.queue.length >= this.queueMaxDepth) {
      return Promise.reject(
        new RateLimitTimeoutError(model, 0, `rate limit queue is full for ${model}`),
      );
    }

    const enqueuedAt = this.now();
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const hintTimer = setTimeout(() => {
        if (settled) return;
        const estimatedWaitMs = Math.max(0, giveupMs - (this.now() - enqueuedAt));
        this.emitQueued(model, this.queue.indexOf(entry) + 1, estimatedWaitMs);
      }, hintMs);
      const giveupTimer = setTimeout(() => {
        removeEntry();
        reject(new RateLimitTimeoutError(model, giveupMs));
      }, giveupMs);
      const onAbort = () => {
        removeEntry();
        reject(abortReason(signal));
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(hintTimer);
        clearTimeout(giveupTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const removeEntry = () => {
        cleanup();
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
      };
      const entry: QueueEntry = {
        model,
        enqueuedAt,
        resolve: () => {
          cleanup();
          const queuedMs = this.now() - enqueuedAt;
          this.emitAcquired(model, queuedMs);
          resolve(queuedMs);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        cleanup,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.inUseCount <= 0) return;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
      return;
    }
    this.inUseCount--;
  }

  dispose(): void {
    for (const entry of this.queue.splice(0)) {
      entry.reject(new RateLimitTimeoutError(entry.model, 0, "rate limit bucket disposed"));
    }
    this.inUseCount = 0;
  }

  private drain(): void {
    while (this.inUseCount < this.capValue && this.queue.length > 0) {
      this.inUseCount++;
      const next = this.queue.shift()!;
      next.resolve();
    }
  }
}

export class ConcurrencyBucket {
  readonly events = new RateLimitEventEmitter();
  private readonly settings: ResolvedConcurrencySettings;
  private readonly now: () => number;
  private readonly semaphores = new Map<RateLimitBucketName, Semaphore>();
  private readonly states = new Map<RateLimitBucketName, ModelState>();

  constructor(opts: ConcurrencyBucketOptions = {}) {
    this.settings = opts.settings ?? resolveConcurrencySettings(opts.rateLimit, opts.env);
    this.now = opts.now ?? (() => Date.now());
  }

  async acquire(
    model: string,
    signal?: AbortSignal,
    giveupMs: number = this.settings.queueGiveupMs,
  ): Promise<ConcurrencyToken> {
    const bucketName = bucketForModel(model);
    this.maybeRestore(bucketName);
    const queuedMs = await this.semaphoreFor(bucketName).acquire(
      model,
      signal,
      giveupMs,
      this.settings.queueHintMs,
    );
    return new ConcurrencyToken(this, bucketName, model, queuedMs);
  }

  note429(model: string): void {
    const bucketName = bucketForModel(model);
    const state = this.stateFor(bucketName);
    const now = this.now();
    state.recent429At.push(now);
    state.recent429At = state.recent429At.filter((ts) => now - ts <= FIVE_MINUTES_MS);
    if (!this.settings.adaptive) return;
    if (
      state.lastNote429At !== null &&
      now - state.lastNote429At < this.settings.throttleWindowMs
    ) {
      state.note429TimesIn5s++;
      return;
    }
    state.cap = Math.max(1, Math.floor(state.cap / 2));
    state.degradedAt = now;
    state.lastNote429At = now;
    state.lastRestoreAt = null;
    state.note429TimesIn5s = 1;
    this.semaphoreFor(bucketName).setCap(state.cap);
  }

  maybeRestore(model: string | RateLimitBucketName): void {
    if (!this.settings.adaptive) return;
    const bucketName = isBucketName(model) ? model : bucketForModel(model);
    const state = this.stateFor(bucketName);
    if (state.degradedAt === null || state.lastNote429At === null) return;
    const now = this.now();
    const lastRestoreOr429 = state.lastRestoreAt ?? state.lastNote429At;
    if (now - lastRestoreOr429 < this.settings.restoreIntervalMs) return;
    state.cap = Math.min(state.initialCap, Math.ceil(state.cap * 1.5));
    state.lastRestoreAt = now;
    if (state.cap === state.initialCap) {
      state.degradedAt = null;
      state.lastNote429At = null;
      state.note429TimesIn5s = 0;
    }
    this.semaphoreFor(bucketName).setCap(state.cap);
  }

  suggestedBackoff(model: string): number | undefined {
    const recent429 = this.stats(model).recent429;
    if (recent429 <= 0) return undefined;
    return Math.min(10_000, 1000 * 2 ** Math.min(recent429 - 1, 3));
  }

  stats(model: string | RateLimitBucketName): ConcurrencyStats {
    const bucketName = isBucketName(model) ? model : bucketForModel(model);
    const state = this.stateFor(bucketName);
    const sem = this.semaphoreFor(bucketName);
    const now = this.now();
    state.recent429At = state.recent429At.filter((ts) => now - ts <= FIVE_MINUTES_MS);
    return {
      inUse: sem.inUse,
      cap: state.cap,
      initialCap: state.initialCap,
      queued: sem.queued,
      recent429: state.recent429At.length,
      degradedAt: state.degradedAt,
      lastRestoreAt: state.lastRestoreAt,
      adaptive: this.settings.adaptive,
    };
  }

  allStats(): Record<RateLimitBucketName, ConcurrencyStats> {
    return {
      pro: this.stats("pro"),
      flash: this.stats("flash"),
      default: this.stats("default"),
    };
  }

  capSettings(): ConcurrencyCapSetting[] {
    return (["pro", "flash", "default"] as const).map((bucket) => this.settings.caps[bucket]);
  }

  adaptiveSource(): RateLimitCapSource {
    return this.settings.adaptiveSource;
  }

  release(bucketName: RateLimitBucketName): void {
    this.semaphoreFor(bucketName).release();
  }

  dispose(): void {
    for (const semaphore of this.semaphores.values()) semaphore.dispose();
  }

  private semaphoreFor(bucketName: RateLimitBucketName): Semaphore {
    let found = this.semaphores.get(bucketName);
    if (!found) {
      const state = this.stateFor(bucketName);
      found = new Semaphore(
        state.cap,
        this.settings.queueMaxDepth,
        this.now,
        (model, depth, estimatedWaitMs) => {
          this.events.emit({ type: "rate-limit.queued", model, depth, estimatedWaitMs });
        },
        (model, queuedMs) => {
          this.events.emit({ type: "rate-limit.acquired", model, queuedMs });
        },
      );
      this.semaphores.set(bucketName, found);
    }
    return found;
  }

  private stateFor(bucketName: RateLimitBucketName): ModelState {
    let found = this.states.get(bucketName);
    if (!found) {
      const setting = this.settings.caps[bucketName];
      found = {
        cap: setting.cap,
        initialCap: setting.cap,
        upstreamCap: setting.upstreamCap,
        degradedAt: null,
        lastRestoreAt: null,
        lastNote429At: null,
        recent429At: [],
        note429TimesIn5s: 0,
      };
      this.states.set(bucketName, found);
    }
    return found;
  }
}

let processBucket: ConcurrencyBucket | null = null;

export function getProcessBucket(rateLimit?: RateLimitConfig): ConcurrencyBucket {
  if (!processBucket) processBucket = new ConcurrencyBucket({ rateLimit });
  return processBucket;
}

export function _resetProcessBucketForTests(): void {
  processBucket?.dispose();
  processBucket = null;
}

export function bucketForModel(model: string): RateLimitBucketName {
  const normalized = model.trim().toLowerCase();
  if (normalized === "v4-pro" || normalized === "deepseek-v4-pro") return "pro";
  if (
    normalized === "v4-flash" ||
    normalized === "deepseek-v4-flash" ||
    normalized === "deepseek-chat" ||
    normalized === "deepseek-reasoner"
  ) {
    return "flash";
  }
  return "default";
}

export function resolveConcurrencySettings(
  rateLimit?: RateLimitConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedConcurrencySettings {
  const caps = {
    pro: resolveCap("pro", rateLimit, env),
    flash: resolveCap("flash", rateLimit, env),
    default: resolveCap("default", rateLimit, env),
  } satisfies Record<RateLimitBucketName, ConcurrencyCapSetting>;
  const envAdaptive = parseBoolean(env.REASONIX_CONCURRENCY_ADAPTIVE);
  const configAdaptive = rateLimit?.concurrency?.adaptive;
  return {
    caps,
    adaptive: envAdaptive ?? configAdaptive ?? true,
    adaptiveSource:
      envAdaptive !== null ? "env" : configAdaptive !== undefined ? "config" : "default",
    queueGiveupMs: positiveInteger(env.REASONIX_QUEUE_GIVEUP_MS) ?? DEFAULT_QUEUE_GIVEUP_MS,
    queueHintMs: positiveInteger(env.REASONIX_QUEUE_HINT_MS) ?? DEFAULT_QUEUE_HINT_MS,
    restoreIntervalMs:
      positiveInteger(env.REASONIX_429_RESTORE_INTERVAL_MS) ?? DEFAULT_RESTORE_INTERVAL_MS,
    throttleWindowMs:
      positiveInteger(env.REASONIX_429_THROTTLE_WINDOW_MS) ?? DEFAULT_THROTTLE_WINDOW_MS,
    queueMaxDepth: positiveInteger(env.REASONIX_QUEUE_MAX_DEPTH) ?? DEFAULT_QUEUE_MAX_DEPTH,
  };
}

function resolveCap(
  bucket: RateLimitBucketName,
  rateLimit: RateLimitConfig | undefined,
  env: Record<string, string | undefined>,
): ConcurrencyCapSetting {
  const upstreamCap = UPSTREAM_CONCURRENCY_CAPS[bucket];
  const envValue = positiveInteger(env[CAP_ENV[bucket]]);
  const configValue = rateLimit?.concurrency?.[bucket];
  const requestedCap = envValue ?? configValue;
  const source: RateLimitCapSource =
    envValue !== undefined ? "env" : configValue !== undefined ? "config" : "default";
  const cap = Math.min(requestedCap ?? upstreamCap, upstreamCap);
  return {
    bucket,
    model: CONCURRENCY_MODEL_IDS[bucket],
    cap,
    upstreamCap,
    source,
    requestedCap,
    manuallyNarrowed: cap < upstreamCap,
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  return null;
}

function isBucketName(value: string): value is RateLimitBucketName {
  return value === "pro" || value === "flash" || value === "default";
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

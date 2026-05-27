const SAMPLE_SIZE = 5;
const DEFAULT_THRESHOLD_MS = 4000;
const UNHEALTHY_ERROR_RATE = 0.5;
const MIN_ERROR_RATE_SAMPLES = 5;
const TIMEOUT_STREAK_LIMIT = 3;

export interface SlowEvent {
  serverName: string;
  p95Ms: number;
  sampleSize: number;
}

export interface UnhealthyEvent {
  serverName: string;
  reason: "error_rate" | "timeout_streak" | "p95";
  p95Ms: number;
  sampleSize: number;
  errorRate: number;
  timeoutStreak: number;
}

export interface LatencySample {
  ok: boolean;
  elapsedMs: number;
  errorKind?: "timeout" | "error";
}

export interface LatencyTrackerOptions {
  thresholdMs?: number;
  onSlow?: (ev: SlowEvent) => void;
  onUnhealthy?: (ev: UnhealthyEvent) => void;
}

export class LatencyTracker {
  private samples: number[] = [];
  private outcomes: LatencySample[] = [];
  private wasOverThreshold = false;
  private wasUnhealthy = false;
  private timeoutStreak = 0;
  private readonly thresholdMs: number;
  private readonly onSlow?: (ev: SlowEvent) => void;
  private readonly onUnhealthy?: (ev: UnhealthyEvent) => void;

  constructor(
    private readonly serverName: string,
    opts: LatencyTrackerOptions = {},
  ) {
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.onSlow = opts.onSlow;
    this.onUnhealthy = opts.onUnhealthy;
  }

  record(sample: number | LatencySample): void {
    const normalized = typeof sample === "number" ? { ok: true, elapsedMs: sample } : sample;
    this.samples.push(normalized.elapsedMs);
    if (this.samples.length > SAMPLE_SIZE) this.samples.shift();
    this.outcomes.push(normalized);
    if (this.outcomes.length > SAMPLE_SIZE) this.outcomes.shift();
    this.timeoutStreak =
      !normalized.ok && normalized.errorKind === "timeout" ? this.timeoutStreak + 1 : 0;
    if (this.samples.length < SAMPLE_SIZE) {
      this.maybeEmitTimeoutStreak();
      return;
    }
    const p95 = computeP95(this.samples);
    const nowOver = p95 > this.thresholdMs;
    if (nowOver && !this.wasOverThreshold) {
      this.onSlow?.({
        serverName: this.serverName,
        p95Ms: p95,
        sampleSize: this.samples.length,
      });
    }
    this.wasOverThreshold = nowOver;
    this.maybeEmitUnhealthy(p95, nowOver);
  }

  private maybeEmitTimeoutStreak(): void {
    if (this.timeoutStreak < TIMEOUT_STREAK_LIMIT || this.wasUnhealthy) return;
    this.wasUnhealthy = true;
    this.onUnhealthy?.({
      serverName: this.serverName,
      reason: "timeout_streak",
      p95Ms: computeP95(this.samples),
      sampleSize: this.samples.length,
      errorRate: this.errorRate(),
      timeoutStreak: this.timeoutStreak,
    });
  }

  private maybeEmitUnhealthy(p95Ms: number, p95Over: boolean): void {
    const errorRate = this.errorRate();
    const reason =
      this.timeoutStreak >= TIMEOUT_STREAK_LIMIT
        ? "timeout_streak"
        : this.outcomes.length >= MIN_ERROR_RATE_SAMPLES && errorRate > UNHEALTHY_ERROR_RATE
          ? "error_rate"
          : p95Over
            ? "p95"
            : null;
    if (reason === null) return;
    if (this.wasUnhealthy) return;
    this.wasUnhealthy = true;
    this.onUnhealthy?.({
      serverName: this.serverName,
      reason,
      p95Ms,
      sampleSize: this.samples.length,
      errorRate,
      timeoutStreak: this.timeoutStreak,
    });
  }

  private errorRate(): number {
    if (this.outcomes.length === 0) return 0;
    const failures = this.outcomes.filter((s) => !s.ok).length;
    return failures / this.outcomes.length;
  }

  markRecovered(): void {
    this.wasUnhealthy = false;
    this.timeoutStreak = 0;
  }
}

/** Plain p95 — sort the buffer and pick the index at floor(N * 0.95). */
export function computeP95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

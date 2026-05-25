export class RateLimitTimeoutError extends Error {
  readonly model: string;
  readonly waitMs: number;

  constructor(model: string, waitMs: number, message?: string) {
    super(message ?? `rate limit queue timed out for ${model} after ${waitMs}ms`);
    this.name = "RateLimitTimeoutError";
    this.model = model;
    this.waitMs = waitMs;
  }
}

export function isRateLimitTimeoutError(err: unknown): err is RateLimitTimeoutError {
  return err instanceof RateLimitTimeoutError || isRateLimitTimeoutShape(err);
}

function isRateLimitTimeoutShape(err: unknown): err is RateLimitTimeoutError {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: unknown; model?: unknown; waitMs?: unknown };
  return (
    maybe.name === "RateLimitTimeoutError" &&
    typeof maybe.model === "string" &&
    typeof maybe.waitMs === "number"
  );
}

/** Ollama `/api/embeddings` adapter — returns L2-normalizable Float32Array, throws actionable error when daemon unreachable. */

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface EmbedOptions {
  /** Ollama base URL. Default `http://localhost:11434`. Override via env or config for remote daemons. */
  baseUrl?: string;
  /** Embedding model name. Default `nomic-embed-text`. */
  model?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Caller-controlled abort. */
  signal?: AbortSignal;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export async function embed(text: string, opts: EmbedOptions = {}): Promise<Float32Array> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Compose abort: caller's signal + our timeout. Either firing
  // tears down the request.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("embedding timeout")), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
    // Connection refused (ECONNREFUSED) is the load-bearing case:
    // Ollama daemon isn't running. Surface the install hint clearly
    // so users don't have to grep a generic node:fetch error.
    const msg = err instanceof Error ? err.message : String(err);
    if (/ECONNREFUSED|connect ECONNREFUSED|fetch failed/i.test(msg)) {
      throw new EmbeddingError(
        `Cannot reach Ollama at ${baseUrl}. Install from https://ollama.com, then run \`ollama pull ${model}\` and \`ollama serve\`. Override the URL via OLLAMA_URL.`,
        err,
      );
    }
    throw new EmbeddingError(`embedding request failed: ${msg}`, err);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 404 from Ollama with `model not found` body means user needs
    // to pull the model. Same logic as the install hint above.
    if (res.status === 404 && /model.*not found/i.test(body)) {
      throw new EmbeddingError(
        `Embedding model "${model}" not pulled. Run \`ollama pull ${model}\` once, then retry.`,
      );
    }
    throw new EmbeddingError(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { embedding?: unknown };
  if (!json.embedding || !Array.isArray(json.embedding)) {
    throw new EmbeddingError(`Ollama response missing 'embedding' array`);
  }
  // Convert once to Float32Array so the cosine inner loop avoids
  // boxing/unboxing per dot product. 4× memory win over number[] too.
  const out = new Float32Array(json.embedding.length);
  for (let i = 0; i < json.embedding.length; i++) {
    const v = json.embedding[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new EmbeddingError(`embedding[${i}] is not a finite number`);
    }
    out[i] = v;
  }
  return out;
}

/** Per-chunk failures emit null + onError; aborts (global) still throw. */
export async function embedAll(
  texts: readonly string[],
  opts: EmbedOptions & {
    onProgress?: (done: number, total: number) => void;
    /** Fired once per failed chunk with the index + error. Default:
     *  none — callers can wire it to log a warning. */
    onError?: (index: number, err: unknown) => void;
  } = {},
): Promise<Array<Float32Array | null>> {
  const out: Array<Float32Array | null> = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i++) {
    if (opts.signal?.aborted) {
      throw new EmbeddingError("embedding aborted");
    }
    const text = texts[i];
    if (text === undefined) continue;
    try {
      out[i] = await embed(text, opts);
    } catch (err) {
      // Don't throw — surface the error, leave a null slot, and
      // continue. If the abort signal fired *during* the request the
      // caller will pick that up on the next loop iteration.
      opts.onError?.(i, err);
    }
    opts.onProgress?.(i + 1, texts.length);
  }
  return out;
}

export async function probeOllama(
  opts: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: opts.signal });
    if (!res.ok) return { ok: false, error: `Ollama returned ${res.status}` };
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (json.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
    return { ok: true, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

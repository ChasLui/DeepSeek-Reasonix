import { type EventSourceMessage, createParser } from "eventsource-parser";
import { type RateLimitConfig, loadRateLimit } from "./config.js";
import { type ConcurrencyBucket, getProcessBucket } from "./rate-limit/index.js";
import { type RetryOptions, fetchWithRetry } from "./retry.js";
import { recordJsonModeEmptyResponse } from "./telemetry/json-mode.js";
import type {
  ChatMessage,
  ChatPrefixOptions,
  ChatRequestOptions,
  FimCompletionOptions,
  RawUsage,
  ToolCall,
  ToolSpec,
} from "./types.js";

type ConcurrencyTokenHandle = Awaited<ReturnType<ConcurrencyBucket["acquire"]>>;
type ChatCompletionEndpointPath = "/chat/completions" | "/beta/chat/completions";
type DeepSeekEndpointPath = ChatCompletionEndpointPath | "/beta/completions";
const DEEPSEEK_USER_ID_RE = /^[a-zA-Z0-9\-_]{1,512}$/;
const MAX_FIM_LOGPROBS = 20;
const MAX_TOOLS = 128;
const MAX_TOP_LOGPROBS = 20;
const MAX_MESSAGES = 1024;
const MAX_FIM_INPUT_BYTES = 1_048_576;

export class DeepSeekRequestShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekRequestShapeError";
  }
}

/** Redact api-key-shaped substrings in error text — defensive only; DeepSeek
 *  itself never echoes Authorization, but malicious mock proxies might. */
function maskSecretsInErrorText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer ***");
}

/** Strip `prefix` from messages for non-prefix endpoints — the main domain
 *  rejects this beta-only field; silent transit would leak prefix artifacts. */
function stripPrefixField(messages: ChatMessage[]): ChatMessage[] {
  let mutated = false;
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.prefix !== undefined) {
      const { prefix: _drop, ...rest } = m;
      out.push(rest);
      mutated = true;
    } else {
      out.push(m);
    }
  }
  return mutated ? out : messages;
}

export interface JsonModeEmptyResponseInfo {
  model: string;
  finishReason: "stop";
}

export class Usage {
  constructor(
    public promptTokens = 0,
    public completionTokens = 0,
    public totalTokens = 0,
    public promptCacheHitTokens = 0,
    public promptCacheMissTokens = 0,
    public reasoningTokens = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    const promptTokens = u.prompt_tokens ?? 0;
    const cacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
    const cacheMissTokens =
      u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
    return new Usage(
      promptTokens,
      u.completion_tokens ?? 0,
      u.total_tokens ?? 0,
      cacheHitTokens,
      cacheMissTokens,
      u.completion_tokens_details?.reasoning_tokens ?? 0,
    );
  }
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
}

export interface FimCompletionChoice {
  text: string;
  finishReason: string | null;
  index: number;
  logprobs: unknown | null;
}

export interface FimCompletionResponse {
  text: string;
  finishReason: string | null;
  choices: FimCompletionChoice[];
  usage: Usage;
  raw: unknown;
}

interface FimCompletionRawChoice {
  text?: string;
  finish_reason?: string | null;
  index?: number;
  logprobs?: unknown | null;
}

interface FimCompletionRawResponse {
  choices?: FimCompletionRawChoice[];
  usage?: RawUsage;
}

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: Usage;
  finishReason?: string;
  raw: any;
}

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface UserBalance {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

/** Largest `total_balance` wins — the wallet the user actually paid for and expects to see ticking down. */
export function pickPrimaryBalance(infos: ReadonlyArray<BalanceInfo>): BalanceInfo | null {
  if (infos.length === 0) return null;
  let best = infos[0]!;
  for (let i = 1; i < infos.length; i++) {
    if (Number(infos[i]!.total_balance) > Number(best.total_balance)) best = infos[i]!;
  }
  return best;
}

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

export interface DeepSeekClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  rateLimit?: RateLimitConfig;
  concurrencyBucket?: ConcurrencyBucket;
  /** Retry configuration. Pass `{ maxAttempts: 1 }` to disable retries. */
  retry?: RetryOptions;
  onJsonModeEmptyResponse?: (info: JsonModeEmptyResponseInfo) => void;
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryOptions;
  private readonly _fetch: typeof fetch;
  private readonly onJsonModeEmptyResponse: ((info: JsonModeEmptyResponseInfo) => void) | undefined;
  private readonly concurrencyBucket: ConcurrencyBucket;
  private readonly minChatIntervalMs: number;
  private nextChatRequestAt = 0;

  constructor(opts: DeepSeekClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Put it in .env or pass apiKey to DeepSeekClient.",
      );
    }
    this.apiKey = apiKey;
    let url = opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    // Manual trim — `/\/+$/` is O(n²) on slash-heavy non-matches per CodeQL js/polynomial-redos.
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    // 11 min. DeepSeek's load-balancer may keep a connection open for
    // up to 10 minutes while the request waits in queue (non-streaming
    // sends empty lines, streaming sends `:` SSE keep-alive comments —
    // both are invisible to our parsers, so neither surfaces until the
    // real response starts). Timing out at the legacy 2-min default
    // killed queued requests prematurely, burned the queue slot on
    // retry, and could loop through the whole queue repeatedly.
    // Setting 11 min lets the server's own 10-min cap close the
    // connection first (clean EOF → natural retry), and our timer
    // is a safety net for genuinely hung sockets.
    this.timeoutMs = opts.timeoutMs ?? 660_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.onJsonModeEmptyResponse = opts.onJsonModeEmptyResponse;
    const rateLimit = opts.rateLimit ?? loadRateLimit();
    this.concurrencyBucket = opts.concurrencyBucket ?? getProcessBucket(rateLimit);
    this.retry = opts.retry ?? {};
    const rpm = rateLimit?.rpm;
    this.minChatIntervalMs = rpm ? Math.ceil(60_000 / rpm) : 0;
  }

  private async waitForChatRateLimit(signal?: AbortSignal): Promise<void> {
    if (this.minChatIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextChatRequestAt - now);
    this.nextChatRequestAt = Math.max(now, this.nextChatRequestAt) + this.minChatIntervalMs;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private buildPayload(
    opts: ChatRequestOptions,
    stream: boolean,
    path: ChatCompletionEndpointPath = "/chat/completions",
  ) {
    this.validateRequestShape(opts);
    const messages =
      path === "/beta/chat/completions" ? opts.messages : stripPrefixField(opts.messages);
    const payload: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream,
    };
    if (opts.tools?.length) payload.tools = this.toolsForPayload(opts);
    if (opts.toolChoice) payload.tool_choice = opts.toolChoice;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
    if (opts.stop !== undefined) payload.stop = opts.stop;
    if (opts.responseFormat) payload.response_format = opts.responseFormat;
    if (stream) payload.stream_options = { include_usage: true, ...opts.streamOptions };
    if (opts.user !== undefined) payload.user_id = opts.user;
    if (opts.logprobs !== undefined) payload.logprobs = opts.logprobs;
    if (opts.topLogprobs !== undefined) payload.top_logprobs = opts.topLogprobs;
    // see ARCHITECTURE.md#api-surface
    if (opts.thinking && !this._isAzureEndpoint()) {
      payload.extra_body = { thinking: { type: opts.thinking } };
    }
    if (opts.reasoningEffort) {
      payload.reasoning_effort = opts.reasoningEffort;
    }
    return payload;
  }

  private buildFimPayload(opts: FimCompletionOptions) {
    this.validateFimRequestShape(opts);
    const payload: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.prompt,
      stream: false,
    };
    if (opts.suffix !== undefined) payload.suffix = opts.suffix;
    if (opts.echo !== undefined) payload.echo = opts.echo;
    if (opts.logprobs !== undefined) payload.logprobs = opts.logprobs;
    if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
    if (opts.stop !== undefined) payload.stop = opts.stop;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.topP !== undefined) payload.top_p = opts.topP;
    return payload;
  }

  private validateRequestShape(opts: ChatRequestOptions): void {
    if (Array.isArray(opts.messages) && opts.messages.length > MAX_MESSAGES) {
      throw new DeepSeekRequestShapeError(
        `messages max ${MAX_MESSAGES} (got ${opts.messages.length})`,
      );
    }
    if (opts.tools && opts.tools.length > MAX_TOOLS) {
      throw new DeepSeekRequestShapeError(`tools max ${MAX_TOOLS}`);
    }
    if (opts.user !== undefined && !DEEPSEEK_USER_ID_RE.test(opts.user)) {
      throw new DeepSeekRequestShapeError("user_id must match [a-zA-Z0-9-_]{1,512}");
    }
    if (opts.logprobs !== undefined && typeof opts.logprobs !== "boolean") {
      throw new DeepSeekRequestShapeError("logprobs must be a boolean");
    }
    if (
      opts.topLogprobs !== undefined &&
      (!Number.isInteger(opts.topLogprobs) ||
        opts.topLogprobs < 0 ||
        opts.topLogprobs > MAX_TOP_LOGPROBS)
    ) {
      throw new DeepSeekRequestShapeError(
        `top_logprobs must be an integer from 0 to ${MAX_TOP_LOGPROBS}`,
      );
    }
    if (opts.topLogprobs !== undefined && opts.logprobs !== true) {
      throw new DeepSeekRequestShapeError("top_logprobs requires logprobs=true");
    }
  }

  private validateFimRequestShape(opts: FimCompletionOptions): void {
    if (typeof opts.prompt !== "string") {
      throw new DeepSeekRequestShapeError("prompt must be a string");
    }
    const inputBytes =
      Buffer.byteLength(opts.prompt) + (opts.suffix ? Buffer.byteLength(opts.suffix) : 0);
    if (inputBytes > MAX_FIM_INPUT_BYTES) {
      throw new DeepSeekRequestShapeError(
        `prompt+suffix byte size ${inputBytes} exceeds ${MAX_FIM_INPUT_BYTES}`,
      );
    }
    if (
      opts.logprobs !== undefined &&
      (!Number.isInteger(opts.logprobs) || opts.logprobs < 0 || opts.logprobs > MAX_FIM_LOGPROBS)
    ) {
      throw new DeepSeekRequestShapeError(
        `logprobs must be an integer from 0 to ${MAX_FIM_LOGPROBS}`,
      );
    }
  }

  private toolsForPayload(opts: ChatRequestOptions): ToolSpec[] {
    if (!opts.toolsStrict) return opts.tools ?? [];
    return (opts.tools ?? []).map((tool) => ({
      ...tool,
      function: { ...tool.function, strict: true },
    }));
  }

  /** Azure OpenAI-compatible endpoints do not accept DeepSeek's proprietary
   *  `extra_body.thinking` field (they reject the request with 400).  We still
   *  send `reasoning_effort`, which Azure *does* support. */
  private _isAzureEndpoint(): boolean {
    try {
      const host = new URL(this.baseUrl).hostname;
      return host === "azure.com" || host.endsWith(".azure.com");
    } catch {
      return false;
    }
  }

  /** Returns null on failure so callers can degrade — session must keep working without balance UI. */
  async getBalance(opts: { signal?: AbortSignal } = {}): Promise<UserBalance | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/user/balance`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: opts.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as UserBalance;
      if (!data || !Array.isArray(data.balance_infos)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Returns null on failure — callers fall back to a hardcoded model hint. */
  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelList | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: opts.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ModelList;
      if (!data || !Array.isArray(data.data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async chat(opts: ChatRequestOptions): Promise<ChatResponse> {
    return this._chatAtPath("/chat/completions", opts, false);
  }

  async chatPrefix(opts: ChatPrefixOptions): Promise<ChatResponse> {
    if (this._isAzureEndpoint()) {
      throw new DeepSeekRequestShapeError(
        "chatPrefix is not supported on Azure OpenAI endpoints (DeepSeek /beta only)",
      );
    }
    if ((opts as { stream?: unknown }).stream) {
      throw new DeepSeekRequestShapeError(
        "chatPrefix does not support streaming — use chat() for SSE",
      );
    }
    this.validatePrefixMessages(opts.messages);
    return this._chatAtPath(
      "/beta/chat/completions",
      {
        ...opts,
        thinking: undefined,
        reasoningEffort: undefined,
      },
      false,
    );
  }

  async pingChatPrefix(opts: { model?: string; signal?: AbortSignal } = {}): Promise<void> {
    await this.chatPrefix({
      model: opts.model ?? "deepseek-v4-flash",
      messages: [
        { role: "user", content: "Reply with one letter." },
        { role: "assistant", content: "o", prefix: true },
      ],
      maxTokens: 1,
      temperature: 0,
      stop: ["\n"],
      signal: opts.signal,
    });
  }

  async completeFim(opts: FimCompletionOptions): Promise<FimCompletionResponse> {
    if (this._isAzureEndpoint()) {
      throw new DeepSeekRequestShapeError(
        "completeFim is not supported on Azure OpenAI endpoints (DeepSeek /beta only)",
      );
    }
    return this._postJsonWithLifecycle<FimCompletionResponse>(
      opts.model,
      opts.signal,
      this.endpoint("/beta/completions"),
      JSON.stringify(this.buildFimPayload(opts)),
      (data: any): FimCompletionResponse => {
        if (!Array.isArray(data?.choices)) {
          throw new Error(`DeepSeek response missing choices array (got ${typeof data?.choices})`);
        }
        const raw = data as FimCompletionRawResponse;
        const choices = (raw.choices ?? []).map((choice, index) => ({
          text: choice.text ?? "",
          finishReason: choice.finish_reason ?? null,
          index: choice.index ?? index,
          logprobs: choice.logprobs ?? null,
        }));
        return {
          text: choices[0]?.text ?? "",
          finishReason: choices[0]?.finishReason ?? null,
          choices,
          usage: Usage.fromApi(raw.usage),
          raw,
        };
      },
    );
  }

  private validatePrefixMessages(messages: ChatPrefixOptions["messages"]): void {
    const last = messages[messages.length - 1];
    if (
      !last ||
      last.role !== "assistant" ||
      last.prefix !== true ||
      typeof last.content !== "string"
    ) {
      throw new DeepSeekRequestShapeError(
        "chatPrefix requires the last message to be an assistant prefix message",
      );
    }
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i]?.prefix) {
        throw new DeepSeekRequestShapeError(
          `chatPrefix: prefix:true is only valid on the final assistant message (saw at index ${i})`,
        );
      }
    }
  }

  private endpoint(path: DeepSeekEndpointPath): string {
    if (this.baseUrl.endsWith("/beta")) {
      if (path.startsWith("/beta/")) {
        return `${this.baseUrl}${path.slice("/beta".length)}`;
      }
      // Caller's baseUrl already terminates at /beta but they're asking for
      // a main-domain endpoint — silently joining would smuggle the request
      // onto the prefix-completion domain (different SLA, possibly different
      // pricing/cache contracts). Fail loud so the user can re-config.
      throw new DeepSeekRequestShapeError(
        `baseUrl ends with /beta but ${path} is a main-domain endpoint; set baseUrl to the host root (chatPrefix/completeFim append /beta automatically)`,
      );
    }
    return `${this.baseUrl}${path}`;
  }

  private async _postJsonWithLifecycle<T>(
    model: string,
    signalOpt: AbortSignal | undefined,
    endpoint: string,
    body: string,
    parse: (data: any) => T,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = signalOpt ?? ctrl.signal;
    const tokenRef: { current: ConcurrencyTokenHandle | undefined } = {
      current: undefined,
    };

    try {
      const resp = await fetchWithRetry(
        async (url, init) => {
          // Acquire must stay inside the fetchFn closure so retries re-acquire
          // a fresh token (released via retryOptionsWithTokenRelease.onRetry).
          tokenRef.current = await this.concurrencyBucket.acquire(model, signal);
          await this.waitForChatRateLimit(signal);
          tokenRef.current.transitionTo("fetching");
          return this._fetch(url, init);
        },
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal,
        },
        this.retryOptionsWithTokenRelease(model, signal, tokenRef),
      );
      if (!resp.ok) {
        throw new Error(`DeepSeek ${resp.status}: ${maskSecretsInErrorText(await resp.text())}`);
      }
      const data = await resp.json();
      return parse(data);
    } finally {
      clearTimeout(timer);
      tokenRef.current?.release();
    }
  }

  private async _chatAtPath(
    path: ChatCompletionEndpointPath,
    opts: ChatRequestOptions,
    _stream: boolean,
  ): Promise<ChatResponse> {
    return this._postJsonWithLifecycle<ChatResponse>(
      opts.model,
      opts.signal,
      this.endpoint(path),
      JSON.stringify(this.buildPayload(opts, false, path)),
      (data: any): ChatResponse => {
        if (!Array.isArray(data?.choices)) {
          throw new Error(`DeepSeek response missing choices array (got ${typeof data?.choices})`);
        }
        const firstChoice = data.choices[0] ?? {};
        const choice = firstChoice.message ?? {};
        this.observeJsonModeEmptyResponse(opts, firstChoice.finish_reason, choice.content);
        return {
          content: choice.content ?? "",
          reasoningContent: choice.reasoning_content ?? null,
          toolCalls: choice.tool_calls ?? [],
          usage: Usage.fromApi(data.usage),
          raw: data,
        };
      },
    );
  }

  private observeJsonModeEmptyResponse(
    opts: ChatRequestOptions,
    finishReason: unknown,
    content: unknown,
  ): void {
    if (
      opts.responseFormat?.type !== "json_object" ||
      finishReason !== "stop" ||
      !(content === "" || content === null)
    ) {
      return;
    }
    try {
      const info = {
        model: opts.model,
        finishReason: "stop",
      } satisfies JsonModeEmptyResponseInfo;
      recordJsonModeEmptyResponse(info);
      this.onJsonModeEmptyResponse?.(info);
    } catch {
      /* best-effort telemetry hook */
    }
  }

  async *stream(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const signal = opts.signal ?? ctrl.signal;
    const tokenRef: { current: ConcurrencyTokenHandle | undefined } = {
      current: undefined,
    };

    try {
      // Only the initial fetch is retried. Once the server has started sending
      // the stream body we do NOT retry — a mid-stream retry would re-bill and
      // desync the session context. Acquire must stay inside the fetchFn closure
      // so retry release+re-acquire works (same invariant as _postJsonWithLifecycle).
      const resp = await fetchWithRetry(
        async (url, init) => {
          tokenRef.current = await this.concurrencyBucket.acquire(opts.model, signal);
          await this.waitForChatRateLimit(signal);
          tokenRef.current.transitionTo("fetching");
          return this._fetch(url, init);
        },
        this.endpoint("/chat/completions"),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(this.buildPayload(opts, true)),
          signal,
        },
        this.retryOptionsWithTokenRelease(opts.model, signal, tokenRef),
      );
      if (!resp.ok || !resp.body) {
        throw new Error(
          `DeepSeek ${resp.status}: ${maskSecretsInErrorText(await resp.text().catch(() => ""))}`,
        );
      }
      tokenRef.current?.transitionTo("streaming");

      const queue: StreamChunk[] = [];
      let done = false;
      let observedContent = "";
      let observedFinishReason: string | undefined;
      const parser = createParser({
        onEvent: (ev: EventSourceMessage) => {
          if (!ev.data || ev.data === "[DONE]") {
            done = true;
            return;
          }
          try {
            const json = JSON.parse(ev.data);
            const delta = json.choices?.[0]?.delta ?? {};
            const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
            if (finishReason) observedFinishReason = finishReason;
            const chunk: StreamChunk = { raw: json, finishReason };
            if (typeof delta.content === "string" && delta.content.length > 0) {
              chunk.contentDelta = delta.content;
              observedContent += delta.content;
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              chunk.reasoningDelta = delta.reasoning_content;
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              const tc = delta.tool_calls[0];
              chunk.toolCallDelta = {
                index: tc.index ?? 0,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments,
              };
            }
            if (json.usage) {
              chunk.usage = Usage.fromApi(json.usage);
            }
            queue.push(chunk);
          } catch {
            /* skip malformed sse frame */
          }
        },
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (done) break;
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        while (queue.length > 0) yield queue.shift()!;
      } finally {
        reader.releaseLock();
      }
      this.observeJsonModeEmptyResponse(opts, observedFinishReason, observedContent);
    } finally {
      clearTimeout(timer);
      tokenRef.current?.release();
    }
  }

  private retryOptionsWithTokenRelease(
    model: string,
    signal: AbortSignal,
    tokenRef: { current: ConcurrencyTokenHandle | undefined },
  ): RetryOptions {
    const options = this.retryOptions(model, signal);
    const userOnRetry = options.onRetry;
    return {
      ...options,
      onRetry: (info) => {
        tokenRef.current?.release();
        tokenRef.current = undefined;
        userOnRetry?.(info);
      },
    };
  }

  private retryOptions(model: string, signal: AbortSignal): RetryOptions {
    const userOnRateLimit = this.retry.onRateLimit;
    return {
      ...this.retry,
      signal,
      model,
      onRateLimit: (resp, seenModel) => {
        const targetModel = seenModel ?? model;
        this.concurrencyBucket.note429(targetModel);
        return (
          userOnRateLimit?.(resp, targetModel) ??
          this.concurrencyBucket.suggestedBackoff(targetModel)
        );
      },
    };
  }
}

export type { ChatMessage, ToolCall, ToolSpec };

import type { ToonMode } from "../config.js";
import { countTokens } from "../tokenizer.js";
import { ToolRegistry } from "../tools.js";
import { serializeStringResult } from "../toon/encode-result.js";
import type { JSONSchema } from "../types.js";
import type { McpClient } from "./client.js";
import { LatencyTracker, type SlowEvent, type UnhealthyEvent } from "./latency.js";
import { shieldMcpResult } from "./shield.js";
import type {
  CallToolResult,
  McpContentBlock,
  McpPromptMessage,
  McpResourceContents,
  McpTool,
} from "./types.js";

export interface BridgeOptions {
  /** Prefix for tool names — disambiguates collisions when bridging multiple servers. */
  namePrefix?: string;
  /** Registry to populate. Creates a fresh one if omitted. */
  registry?: ToolRegistry;
  /** Session toolset gate — when present, a bridged tool whose name returns false is unregistered and excluded from `registeredNames` (never enters the prefix). Absent ⟹ all bridged tools kept. */
  toolFilter?: (registeredName: string) => boolean;
  /** Warm tools/list candidate loaded from the stdio schema cache after synchronous metadata verification. */
  mcpToolsOverride?: McpTool[];
  /** Auto-flatten deep schemas (Pillar 3). Defaults to the registry's own default (true). */
  autoFlatten?: boolean;
  /** Cap on tool result chars; head+tail truncation. Floor against context-poisoning oversized reads. */
  maxResultChars?: number;
  /** Absent → no `_meta.progressToken` sent and server won't emit progress. */
  onProgress?: (info: {
    toolName: string;
    progress: number;
    total?: number;
    message?: string;
  }) => void;
  /** Server name used to tag latency samples + slow events. Falls through to namePrefix without trailing `_`. */
  serverName?: string;
  /** p95 cutoff in ms before a slow event fires — defaults to 4000. */
  slowThresholdMs?: number;
  /** Fired exactly when the per-server p95 transitions over `slowThresholdMs`. */
  onSlow?: (ev: SlowEvent) => void;
  /** Fired once when latency or error samples cross the unhealthy threshold. */
  onUnhealthy?: (ev: UnhealthyEvent) => void;
  /** Indirection so reconnect can swap the underlying client without re-registering tools. */
  host?: McpClientHost;
  /** Awaited before each `callTool` — resolves on `connected`, rejects on `failed`, caps via `readyTimeoutMs`. */
  ready?: Promise<void>;
  /** How long to wait on `ready` before failing the dispatch. Default 30_000ms. */
  readyTimeoutMs?: number;
}

/** Mutable holder so `/mcp reconnect` can swap the underlying client without re-bridging tools. */
export interface McpClientHost {
  client: McpClient;
}

export const DEFAULT_MAX_RESULT_CHARS = 32_000;

/** ~6% of DeepSeek V3 context. Char cap alone fails on CJK (~1 char/token). */
export const DEFAULT_MAX_RESULT_TOKENS = 8_000;

/** Default per-call wait before failing if the server is still handshaking. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface BridgeResult {
  registry: ToolRegistry;
  /** Names actually registered (may differ from MCP names when a prefix is applied). */
  registeredNames: string[];
  /** Raw server tool list used as reconnect/listChanged baseline. */
  mcpTools: McpTool[];
  /** Names the server listed but the bridge skipped (e.g. invalid schemas). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Resolved bridge environment that `registerSingleMcpTool` needs. Stored on summaries so reconnect can append new tools later. */
export interface BridgeEnv {
  registry: ToolRegistry;
  host: McpClientHost;
  prefix: string;
  maxResultChars: number;
  tracker: LatencyTracker | null;
  onProgress?: BridgeOptions["onProgress"];
  /** Optional readiness gate awaited before each `callTool` dispatch. */
  ready?: Promise<void>;
  /** Timeout for waiting on `ready` — milliseconds. Defaults to DEFAULT_READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
  /** Server name surfaced in timeout errors. Defaults to the prefix or "anon". */
  serverName?: string;
}

/** Register one MCP tool's bridged closure into the registry. Returns the registered name (or "" if skipped). */
export function registerSingleMcpTool(
  mcpTool: import("./types.js").McpTool,
  env: BridgeEnv,
): string {
  if (!mcpTool.name) return "";
  const registeredName = `${env.prefix}${mcpTool.name}`;
  env.registry.register({
    name: registeredName,
    description: mcpTool.description ?? "",
    parameters: mcpTool.inputSchema as JSONSchema,
    fn: async (args: Record<string, unknown>, ctx) => {
      if (env.ready) {
        await waitForReady(
          env.ready,
          env.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
          env.serverName ?? (env.prefix.replace(/_$/, "") || "anon"),
          ctx?.signal,
        );
      }
      const t0 = env.tracker ? Date.now() : 0;
      // Resolve client at call time via the host indirection so `/mcp reconnect`
      // can swap a fresh client in without re-bridging tools.
      const live = env.host.client;
      let toolResult: CallToolResult;
      try {
        toolResult = await live.callTool(mcpTool.name, args, {
          onProgress: env.onProgress
            ? (info) => env.onProgress!({ toolName: registeredName, ...info })
            : undefined,
          signal: ctx?.signal,
        });
        if (env.tracker) env.tracker.record({ ok: true, elapsedMs: Date.now() - t0 });
      } catch (err) {
        if (env.tracker) {
          env.tracker.record({
            ok: false,
            elapsedMs: Date.now() - t0,
            errorKind: classifyMcpCallError(err),
          });
        }
        throw err;
      }
      return flattenMcpResult(toolResult, {
        maxChars: env.maxResultChars,
        toonMode: env.registry.toonMode,
      });
    },
  });
  return registeredName;
}

async function waitForReady(
  ready: Promise<void>,
  timeoutMs: number,
  serverName: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      ready.then(
        () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `MCP server "${serverName}" still handshaking after ${timeoutMs}ms — try /mcp reconnect or check the server logs.`,
            ),
          );
        }, timeoutMs);
      }
      if (signal) {
        if (signal.aborted) {
          if (settled) return;
          settled = true;
          reject(new Error("aborted"));
          return;
        }
        onAbort = () => {
          if (settled) return;
          settled = true;
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function bridgeMcpTools(
  client: McpClient,
  opts: BridgeOptions = {},
): Promise<BridgeResult & { env: BridgeEnv }> {
  const registry = opts.registry ?? new ToolRegistry({ autoFlatten: opts.autoFlatten });
  const prefix = opts.namePrefix ?? "";
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const result: BridgeResult = {
    registry,
    registeredNames: [],
    mcpTools: [],
    skipped: [],
  };

  const serverName = opts.serverName ?? prefix.replace(/_$/, "") ?? "anon";
  const tracker =
    opts.onSlow || opts.onUnhealthy
      ? new LatencyTracker(serverName, {
          thresholdMs: opts.slowThresholdMs,
          onSlow: opts.onSlow,
          onUnhealthy: opts.onUnhealthy,
        })
      : null;
  // Synthesize a host on the fly when the caller didn't provide one. Older
  // callers (tests, single-shot non-reconnectable bridges) get the live
  // `client` reference frozen in; reconnect-aware callers pass their own
  // mutable host.
  const host: McpClientHost = opts.host ?? { client };
  const env: BridgeEnv = {
    registry,
    host,
    prefix,
    maxResultChars,
    tracker,
    onProgress: opts.onProgress,
    ready: opts.ready,
    readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    serverName,
  };
  const listed = opts.mcpToolsOverride
    ? { tools: opts.mcpToolsOverride }
    : await client.listTools();
  result.mcpTools = listed.tools;
  for (const mcpTool of listed.tools) {
    if (!mcpTool.name) {
      result.skipped.push({ name: "?", reason: "empty tool name" });
      continue;
    }
    const registeredName = registerSingleMcpTool(mcpTool, env);
    if (!registeredName) continue;
    if (opts.toolFilter && !opts.toolFilter(registeredName)) {
      registry.unregister(registeredName);
      result.skipped.push({
        name: registeredName,
        reason: "not in session toolset",
      });
      continue;
    }
    result.registeredNames.push(registeredName);
  }
  return { ...result, env };
}

export async function bridgeMcpResources(
  client: McpClient,
  opts: Pick<BridgeOptions, "registry" | "serverName" | "maxResultChars"> = {},
): Promise<BridgeResult> {
  const registry = opts.registry ?? new ToolRegistry();
  const result: BridgeResult = {
    registry,
    registeredNames: [],
    mcpTools: [],
    skipped: [],
  };
  if (!capabilityAdvertised(client.serverCapabilities.resources)) return result;
  const knownResourceUris = new Set<string>();
  const knownResourceTemplates = new Set<RegExp>();
  const DEFAULT_SCHEMES: readonly string[] = ["http:", "https:"];
  let allowedSchemes = new Set<string>(DEFAULT_SCHEMES);
  const maxChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const prefix = mcpToolNamespace(opts.serverName ?? client.serverInfo.name);

  const listName = `${prefix}list_resources`;
  registry.register({
    name: listName,
    description: "List resources exposed by this MCP server.",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    parallelSafe: true,
    fn: async () => {
      const listed = await client.listResources();
      const nextSchemes = new Set<string>(DEFAULT_SCHEMES);
      knownResourceUris.clear();
      knownResourceTemplates.clear();
      for (const resource of listed.resources) {
        knownResourceUris.add(resource.uri);
        const scheme = uriScheme(resource.uri);
        if (scheme && !blockedUriScheme(scheme)) nextSchemes.add(scheme);
      }
      for (const template of resourceTemplates(listed)) {
        knownResourceTemplates.add(uriTemplateToRegExp(template));
        const scheme = uriScheme(template.replace(/\{[^}]+\}/g, "placeholder"));
        if (scheme && !blockedUriScheme(scheme)) nextSchemes.add(scheme);
      }
      allowedSchemes = nextSchemes;
      return JSON.stringify(listed, null, 2);
    },
  });
  result.registeredNames.push(listName);

  const readName = `${prefix}read_resource`;
  registry.register({
    name: readName,
    description: "Read a previously listed resource from this MCP server.",
    parameters: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Resource URI from list_resources.",
        },
      },
      required: ["uri"],
    },
    readOnly: true,
    fn: async (args: { uri?: unknown }) => {
      const uri = typeof args.uri === "string" ? args.uri : "";
      assertReadableResourceUri(uri, knownResourceUris, knownResourceTemplates, allowedSchemes);
      const result = await client.readResource(uri);
      return formatResourceContents(result.contents, maxChars);
    },
  });
  result.registeredNames.push(readName);
  return result;
}

export async function bridgeMcpPrompts(
  client: McpClient,
  opts: Pick<BridgeOptions, "registry" | "serverName" | "maxResultChars"> = {},
): Promise<BridgeResult> {
  const registry = opts.registry ?? new ToolRegistry();
  const result: BridgeResult = {
    registry,
    registeredNames: [],
    mcpTools: [],
    skipped: [],
  };
  if (!capabilityAdvertised(client.serverCapabilities.prompts)) return result;
  const maxChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const prefix = mcpToolNamespace(opts.serverName ?? client.serverInfo.name);

  const listName = `${prefix}list_prompts`;
  registry.register({
    name: listName,
    description: "List prompt templates exposed by this MCP server.",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    parallelSafe: true,
    fn: async () => JSON.stringify(await client.listPrompts(), null, 2),
  });
  result.registeredNames.push(listName);

  const getName = `${prefix}get_prompt`;
  registry.register({
    name: getName,
    description: "Get a prompt template from this MCP server.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", properties: {} },
      },
      required: ["name"],
    },
    readOnly: true,
    fn: async (args: { name?: unknown; arguments?: unknown }) => {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("name is required");
      const rawArgs =
        args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
          ? stringRecord(args.arguments as Record<string, unknown>)
          : undefined;
      const prompt = await client.getPrompt(name, rawArgs);
      return JSON.stringify(
        {
          ...prompt,
          messages: prompt.messages.map((m) => sanitizePromptMessage(m, maxChars)),
        },
        null,
        2,
      );
    },
  });
  result.registeredNames.push(getName);
  return result;
}

export interface FlattenOptions {
  /** Cap the flattened string at this many characters. Default: no cap. */
  maxChars?: number;
  toonMode?: ToonMode;
  /** Shield kill-switch override — false bypasses MCP response shielding regardless of REASONIX_SHIELD. */
  mcpShield?: { enabled?: boolean };
}

export function flattenMcpResult(result: CallToolResult, opts: FlattenOptions = {}): string {
  validateResultShape(result);
  // Shield pre-pass: shape-aware reduction before head+tail truncation.
  // Bypass via REASONIX_SHIELD=0 (env) or opts.mcpShield.enabled===false (config).
  let shielded = result;
  if (process.env.REASONIX_SHIELD !== "0" && opts.mcpShield?.enabled !== false) {
    try {
      shielded = shieldMcpResult(result);
    } catch {
      shielded = result; // fail-close: fallback to raw on unexpected shield error
    }
  }
  const parts = shielded.content.map((block) => blockToString(block, opts));
  const joined = parts.join("\n").trim();
  const prefixed = shielded.isError
    ? `ERROR: ${joined || "(no error message from server)"}`
    : joined;
  return opts.maxChars ? truncateForModel(prefixed, opts.maxChars) : prefixed;
}

/** Runtime schema check — MCP server responses cross a network boundary and the TypeScript types are compile-time only. */
function validateResultShape(result: CallToolResult): void {
  if (typeof result !== "object" || !result)
    throw new Error(`MCP server returned non-object result: ${typeof result}`);
  const { content, isError: _isError } = result as {
    content: unknown;
    isError?: unknown;
  };
  if (!Array.isArray(content))
    throw new Error(`MCP server returned result with non-array content: ${typeof content}`);
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as Record<string, unknown> | null | undefined;
    if (typeof block !== "object" || !block)
      throw new Error(`MCP server returned result.content[${i}] is not an object`);
    if (block.type !== "text" && block.type !== "image")
      throw new Error(
        `MCP server returned result.content[${i}] with unknown type ${JSON.stringify(block.type)}`,
      );
    if (block.type === "text" && typeof block.text !== "string")
      throw new Error(
        `MCP server returned result.content[${i}] with non-string text (${typeof block.text})`,
      );
    if (block.type === "image") {
      if (typeof block.data !== "string")
        throw new Error(
          `MCP server returned result.content[${i}] with non-string data (${typeof block.data})`,
        );
      if (typeof block.mimeType !== "string")
        throw new Error(
          `MCP server returned result.content[${i}] with non-string mimeType (${typeof block.mimeType})`,
        );
    }
  }
}

function classifyMcpCallError(err: unknown): "timeout" | "error" {
  const message = err instanceof Error ? err.message : String(err);
  return /\btimeout|timed out\b/i.test(message) ? "timeout" : "error";
}

function capabilityAdvertised(capability: unknown): boolean {
  return typeof capability === "object" && capability !== null;
}

function mcpToolNamespace(serverName: string): string {
  const cleaned = serverName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return `mcp__${cleaned || "server"}__`;
}

function uriScheme(uri: string): string | null {
  try {
    return new URL(uri).protocol;
  } catch {
    return null;
  }
}

function blockedUriScheme(scheme: string): boolean {
  return ["data:", "javascript:", "vbscript:", "chrome:", "chrome-extension:"].includes(scheme);
}

function assertReadableResourceUri(
  uri: string,
  knownResourceUris: ReadonlySet<string>,
  knownResourceTemplates: ReadonlySet<RegExp>,
  allowedSchemes: ReadonlySet<string>,
): void {
  if (
    !knownResourceUris.has(uri) &&
    ![...knownResourceTemplates].some((template) => template.test(uri))
  ) {
    throw new Error("read_resource uri must come from this session's list_resources result");
  }
  const scheme = uriScheme(uri);
  if (!scheme || blockedUriScheme(scheme) || !allowedSchemes.has(scheme)) {
    throw new Error(`read_resource blocked URI scheme: ${scheme ?? "(none)"}`);
  }
}

function resourceTemplates(listed: unknown): string[] {
  const raw = (listed as { resourceTemplates?: unknown }).resourceTemplates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { uriTemplate?: unknown }).uriTemplate
        : undefined,
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function uriTemplateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/(\{[^}]+\})/g)
    .map((part) => (part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`);
}

function formatResourceContents(
  contents: readonly McpResourceContents[],
  maxChars: number,
): string {
  const parts = contents.map((content) => {
    if ("blob" in content) {
      const size = estimateBase64DecodedBytes(content.blob);
      if (size > maxChars) throw new Error(`resource blob exceeds ${maxChars} bytes`);
      return `[binary resource ${content.uri}, ${content.mimeType ?? "application/octet-stream"}, ${size} bytes]`;
    }
    if (content.text.length > maxChars) throw new Error(`resource text exceeds ${maxChars} bytes`);
    return content.text;
  });
  return parts.join("\n").trim();
}

function estimateBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function sanitizePromptMessage(message: McpPromptMessage, maxChars: number): McpPromptMessage {
  if (message.content.type !== "resource") return message;
  const resource = message.content.resource;
  if (!("blob" in resource)) {
    if (resource.text.length <= maxChars) return message;
    return {
      ...message,
      content: {
        type: "text",
        text: `[text resource ${resource.uri}, ${resource.mimeType ?? "text/plain"}, ${resource.text.length} bytes truncated]`,
      },
    };
  }
  return {
    ...message,
    content: {
      type: "text",
      text: `[binary resource ${resource.uri}, ${resource.mimeType ?? "application/octet-stream"}, ${estimateBase64DecodedBytes(resource.blob)} bytes]`,
    },
  };
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** Head + 1KB tail so error messages at end of stack traces aren't lost. */
export function truncateForModel(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const tailBudget = Math.min(1024, Math.floor(maxChars * 0.1));
  const headBudget = Math.max(0, maxChars - tailBudget);
  const head = s.slice(0, headBudget);
  const tail = s.slice(-tailBudget);
  const dropped = s.length - head.length - tail.length;
  return `${head}\n\n[…truncated ${dropped} chars — raise BridgeOptions.maxResultChars, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

/** Never tokenizes full input — pathological repetitive text (`AAAA…`) costs 30s+ on the pure-TS BPE port. */
export function truncateForModelByTokens(s: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  // Every token is ≥1 char — if length ≤ budget, tokens ≤ budget.
  if (s.length <= maxTokens) return s;
  // Small enough to tokenize-check without pathological cost: confirm
  // whether we're actually over budget. (Threshold is the char-bound
  // worst case for English/code — ~4 chars/token.)
  if (s.length <= maxTokens * 4) {
    const tokens = countTokens(s);
    if (tokens <= maxTokens) return s;
  }

  const markerOverhead = 48; // rough token cost of the truncation marker
  const contentBudget = Math.max(0, maxTokens - markerOverhead);
  const tailBudget = Math.min(256, Math.floor(contentBudget * 0.1));
  const headBudget = Math.max(0, contentBudget - tailBudget);

  const head = sizePrefixToTokens(s, headBudget);
  const tail = sizeSuffixToTokens(s, tailBudget);
  const droppedChars = s.length - head.length - tail.length;
  // Estimate dropped tokens from the per-slice char/token ratio we
  // already measured, rather than paying another full-string tokenize.
  // The marker says "~N tokens" so the ≤10% slop is visible to readers.
  const headTokens = head ? countTokens(head) : 0;
  const tailTokens = tail ? countTokens(tail) : 0;
  const sampleChars = head.length + tail.length;
  const sampleTokens = headTokens + tailTokens;
  const ratio = sampleChars > 0 ? sampleTokens / sampleChars : 0.3;
  const estTotalTokens = Math.ceil(s.length * ratio);
  const droppedTokens = Math.max(0, estTotalTokens - sampleTokens);
  return `${head}\n\n[…truncated ~${droppedTokens} tokens (${droppedChars} chars) — raise BridgeOptions.maxResultTokens, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

function sizePrefixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  // Optimistic starting size: assume ~4 chars/token (English/code
  // average). If the content is denser (CJK ~1 char/token), the first
  // tokenize will show we're over and we shrink.
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(0, size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    // Shrink by the overshoot fraction plus a small safety margin.
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(0, Math.max(0, size - 1));
    size = next;
  }
  return s.slice(0, Math.max(0, size));
}

/** Slice `s` from the end to the largest suffix that fits `budget` tokens. */
function sizeSuffixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(-size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(-Math.max(0, size - 1));
    size = next;
  }
  return s.slice(-Math.max(0, size));
}

function blockToString(block: McpContentBlock, opts: FlattenOptions): string {
  if (block.type === "text") return serializeStringResult(block.text, { mode: opts.toonMode });
  if (block.type === "image") return `[image ${block.mimeType}, ${block.data.length} chars base64]`;
  // Unknown block type — preserve for diagnostics.
  return `[unknown block: ${JSON.stringify(block)}]`;
}

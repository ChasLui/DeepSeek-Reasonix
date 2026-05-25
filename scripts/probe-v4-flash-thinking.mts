#!/usr/bin/env node

type ProbeKind = "enabled" | "disabled" | "omitted";

interface ProbeResult {
  kind: ProbeKind;
  status: number;
  ok: boolean;
  reasoningContentLength: number;
  contentLength: number;
  completionTokensDetails: unknown;
  raw: unknown;
}

interface CliOptions {
  key?: string;
  baseUrl: string;
  json: boolean;
}

const MODEL = "deepseek-v4-flash";
const PROMPT = "What is 17 + 25?";
const KINDS: readonly ProbeKind[] = ["enabled", "disabled", "omitted"];

function usage(): string {
  return `Usage: npx tsx scripts/probe-v4-flash-thinking.mts [options]

Options:
  --key <key>        DeepSeek API key (default: DEEPSEEK_API_KEY)
  --base-url <url>   DeepSeek API base URL (default: DEEPSEEK_BASE_URL or https://api.deepseek.com)
  --json             Emit machine-readable JSON
  --help             Show this help
`;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--key") {
      opts.key = requireValue(argv, ++i, "--key");
    } else if (arg === "--base-url") {
      opts.baseUrl = requireValue(argv, ++i, "--base-url");
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function buildBody(kind: ProbeKind): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: PROMPT }],
    reasoning_effort: "high",
  };
  if (kind !== "omitted") {
    body.extra_body = { thinking: { type: kind } };
  }
  return body;
}

function extractReasoningContent(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof reasoningContent === "string" ? reasoningContent : "";
}

function extractContent(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function extractCompletionTokensDetails(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = (raw as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return (usage as { completion_tokens_details?: unknown }).completion_tokens_details;
}

function sanitize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, child) =>
      typeof child === "string" ? redactSecretLikeStrings(child) : child,
    ),
  );
}

function redactSecretLikeStrings(value: string): string {
  const bearerKeyPattern = new RegExp(`Bearer\\s+${"sk-"}[A-Za-z0-9_-]+`, "g");
  const keyPattern = new RegExp(`${"sk-"}[A-Za-z0-9_-]{8,}`, "g");
  return value
    .replace(bearerKeyPattern, "Bearer <redacted>")
    .replace(keyPattern, "<redacted>");
}

async function runProbe(kind: ProbeKind, opts: Required<Pick<CliOptions, "key" | "baseUrl">>) {
  const url = new URL("/chat/completions", opts.baseUrl.replace(/\/+$/, ""));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBody(kind)),
  });
  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { nonJsonBody: text };
  }

  const safeRaw = sanitize(raw);
  return {
    kind,
    status: response.status,
    ok: response.ok,
    reasoningContentLength: extractReasoningContent(raw).length,
    contentLength: extractContent(raw).length,
    completionTokensDetails: extractCompletionTokensDetails(raw),
    raw: safeRaw,
  } satisfies ProbeResult;
}

function printText(results: readonly ProbeResult[]): void {
  for (const result of results) {
    process.stdout.write(
      [
        `${result.kind}: HTTP ${result.status}`,
        `reasoning_content=${result.reasoningContentLength}`,
        `content=${result.contentLength}`,
        `completion_tokens_details=${JSON.stringify(result.completionTokensDetails ?? null)}`,
      ].join(" | "),
    );
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const key = opts.key || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is required");

  const results: ProbeResult[] = [];
  for (const kind of KINDS) {
    results.push(await runProbe(kind, { key, baseUrl: opts.baseUrl }));
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ model: MODEL, prompt: PROMPT, results }, null, 2)}\n`);
  } else {
    printText(results);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});

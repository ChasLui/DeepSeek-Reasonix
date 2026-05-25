import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekClient } from "../../src/client.js";
import type { ChatMessage } from "../../src/types.js";

interface BenchRow {
  turn: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  total_tokens: number;
  question: string;
}

const BENCH_NAME = "long-doc-qa";
const MODEL = "deepseek-v4-flash";
const DOC_BYTES = 8192;
const QUESTIONS = [
  "Summarize the four Reasonix architecture pillars in three bullets.",
  "Which cache-first invariants matter most for prompt cache stability?",
  "What operational checks would you inspect before changing the loop?",
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("skip: DEEPSEEK_API_KEY missing");
    return;
  }
  const turns = parseTurns(3);
  const doc = readFileSync(join(repoRoot, "docs", "ARCHITECTURE.md"), "utf8").slice(0, DOC_BYTES);
  const client = new DeepSeekClient({ timeoutMs: 660_000 });
  const rows: BenchRow[] = [];
  await warmPrefix(client, doc);

  for (let index = 0; index < turns; index++) {
    const question = QUESTIONS[index % QUESTIONS.length]!;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You answer questions about the supplied architecture document concisely.",
      },
      {
        role: "user",
        content: `Document:\n${doc}\n\nQuestion: ${question}`,
      },
    ];
    const response = await client.chat({
      model: MODEL,
      messages,
      temperature: 0,
      maxTokens: 240,
      reasoningEffort: "high",
    });
    rows.push({
      turn: index + 1,
      prompt_cache_hit_tokens: response.usage.promptCacheHitTokens,
      prompt_cache_miss_tokens: response.usage.promptCacheMissTokens,
      total_tokens: response.usage.totalTokens,
      question,
    });
  }

  writeResults(BENCH_NAME, rows);
  assertHitAfterFirstTurn(rows);
}

function parseTurns(defaultTurns: number): number {
  const idx = process.argv.indexOf("--turns");
  const raw = idx >= 0 ? process.argv[idx + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : defaultTurns;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTurns;
}

function assertHitAfterFirstTurn(rows: readonly BenchRow[]): void {
  const misses = rows.slice(1).filter((row) => row.prompt_cache_hit_tokens <= 0);
  if (misses.length > 0) {
    throw new Error("expected prompt_cache_hit_tokens > 0 from turn 2 onward");
  }
}

async function warmPrefix(client: DeepSeekClient, doc: string): Promise<void> {
  await client.chat({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You answer questions about the supplied architecture document concisely.",
      },
      {
        role: "user",
        content: `Document:\n${doc}\n\nAcknowledge that the document is loaded.`,
      },
    ],
    temperature: 0,
    maxTokens: 32,
    reasoningEffort: "high",
  });
}

function writeResults(name: string, rows: readonly BenchRow[]): void {
  const outDir = join(here, "results", name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.json"),
    `${JSON.stringify({ name, model: MODEL, rows }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "results.md"), renderMarkdown(name, rows));
}

function renderMarkdown(name: string, rows: readonly BenchRow[]): string {
  const lines = [
    `# ${name}`,
    "",
    "| turn | hit_tokens | miss_tokens | total_tokens | question |",
    "| ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.turn} | ${row.prompt_cache_hit_tokens} | ${row.prompt_cache_miss_tokens} | ${row.total_tokens} | ${row.question} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

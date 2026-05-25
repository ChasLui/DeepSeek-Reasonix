import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekClient } from "../../src/client.js";
import type { ChatMessage } from "../../src/types.js";

interface BenchRow {
  turn: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  cumulative_hit_tokens: number;
  total_tokens: number;
}

const BENCH_NAME = "multi-turn-chat";
const MODEL = "deepseek-v4-flash";
const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("skip: DEEPSEEK_API_KEY missing");
    return;
  }
  const turns = parseTurns(5);
  const client = new DeepSeekClient({ timeoutMs: 660_000 });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a concise planning assistant. Maintain the exact conversation prefix and answer in one paragraph.",
    },
  ];
  const rows: BenchRow[] = [];
  let cumulativeHitTokens = 0;

  for (let index = 0; index < turns; index++) {
    messages.push({ role: "user", content: userMessage(index + 1) });
    const response = await client.chat({
      model: MODEL,
      messages: [...messages],
      temperature: 0,
      maxTokens: 180,
      reasoningEffort: "high",
    });
    cumulativeHitTokens += response.usage.promptCacheHitTokens;
    rows.push({
      turn: index + 1,
      prompt_cache_hit_tokens: response.usage.promptCacheHitTokens,
      prompt_cache_miss_tokens: response.usage.promptCacheMissTokens,
      cumulative_hit_tokens: cumulativeHitTokens,
      total_tokens: response.usage.totalTokens,
    });
    messages.push({ role: "assistant", content: response.content });
  }

  writeResults(BENCH_NAME, rows);
  assertCumulativeHits(rows);
}

function parseTurns(defaultTurns: number): number {
  const idx = process.argv.indexOf("--turns");
  const raw = idx >= 0 ? process.argv[idx + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : defaultTurns;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultTurns;
}

function userMessage(turn: number): string {
  return [
    `Turn ${turn}: assess one risk in a cache-first coding-agent loop.`,
    "Keep the same terminology across turns: immutable prefix, append-only log, volatile scratch, tool repair, and cost routing.",
    "Use the prior answers as context, avoid reordering the discussion, and add one concrete verification idea.",
    "Preserve this shared scenario in every request: a local coding agent is running long sessions against DeepSeek, tool calls append to the transcript, summaries are auxiliary flash calls, and operators inspect prompt_cache_hit_tokens plus prompt_cache_miss_tokens after each turn.",
    "Frame the answer around stable prompt bytes, bounded queues, explicit cache-break evidence, and the risk of confusing best-effort server eviction with local prompt drift.",
  ].join(" ");
}

function assertCumulativeHits(rows: readonly BenchRow[]): void {
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (current.prompt_cache_hit_tokens <= 0) {
      throw new Error("expected prompt_cache_hit_tokens > 0 from turn 2 onward");
    }
    if (current.cumulative_hit_tokens < previous.cumulative_hit_tokens) {
      throw new Error("expected cumulative hit tokens to be monotonic");
    }
  }
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
    "| turn | hit_tokens | miss_tokens | cumulative_hit_tokens | total_tokens |",
    "| ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.turn} | ${row.prompt_cache_hit_tokens} | ${row.prompt_cache_miss_tokens} | ${row.cumulative_hit_tokens} | ${row.total_tokens} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

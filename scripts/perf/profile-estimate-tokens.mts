// Profile estimateRequestTokens CPU cost vs typical DeepSeek API round-trip.
// Slice 1 / Task 1.3 of 2026-06-02-token-cache-optimization-10-points-ral.md.
// Pure-CPU, no API calls (NF-003: Slice 1 changes no src/ runtime behaviour).
// Answers SC-002: is local tokenize a real hot-spot worth caching (scheme 4)?
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateRequestTokens } from "../../src/tokenizer.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function arg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  const raw = idx >= 0 ? process.argv[idx + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TURNS = arg("--turns", 40);
const ITERATIONS = arg("--iterations", 200);

// Real-scale message history: tile ARCHITECTURE.md across N turns so the local
// tokenizer chews a realistic long-session prompt (tens of thousands of tokens).
const doc = readFileSync(join(repoRoot, "docs", "ARCHITECTURE.md"), "utf8");
const messages: Array<{ role: string; content: string }> = [
  { role: "system", content: "You are a cache-first coding agent. Keep the prompt prefix byte-stable." },
];
for (let i = 0; i < TURNS; i++) {
  const start = (i * 1500) % Math.max(1, doc.length - 1500);
  const slice = doc.slice(start, start + 1500);
  messages.push({ role: "user", content: `Turn ${i}: ${slice}` });
  messages.push({ role: "assistant", content: `Ack ${i}. ${slice.slice(0, 400)}` });
}

// Real-scale tool specs: ~25 standard-format tools with nested params, matching
// a fully loaded session (filesystem + shell + memory + web + skills + MCP).
const toolSpecs = Array.from({ length: 25 }, (_, i) => ({
  type: "function",
  function: {
    name: `tool_${i}`,
    description: `Tool ${i} performing a documented operation with several parameters and edge cases.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "A filesystem path argument." },
        count: { type: "number", description: "How many items to process." },
        flag: { type: "boolean", description: "Toggle alternate behaviour." },
        items: { type: "array", items: { type: "string" }, description: "List of string items." },
      },
      required: ["path"],
    },
  },
}));

// Warm up lazy tokenizer singleton + JIT before measuring.
let tokens = 0;
for (let i = 0; i < 5; i++) tokens = estimateRequestTokens(messages, toolSpecs);

const samples: number[] = [];
for (let i = 0; i < ITERATIONS; i++) {
  const t0 = performance.now();
  tokens = estimateRequestTokens(messages, toolSpecs);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const p50 = at(0.5);

const report = {
  turns: TURNS,
  messages: messages.length,
  toolSpecs: toolSpecs.length,
  estimated_tokens: tokens,
  iterations: ITERATIONS,
  tokenize_ms: {
    p50: Number(p50.toFixed(3)),
    p99: Number(at(0.99).toFixed(3)),
    mean: Number(mean.toFixed(3)),
    max: Number(samples[samples.length - 1]!.toFixed(3)),
  },
  // DeepSeek has no latency field in usage.jsonl; these are typical anchors.
  // reasoning_effort:high calls routinely take 1-several seconds (thinking).
  pct_of_wall_clock: {
    "api_200ms": Number(((p50 / 200) * 100).toFixed(3)),
    "api_2000ms": Number(((p50 / 2000) * 100).toFixed(3)),
  },
};
console.log(JSON.stringify(report, null, 2));

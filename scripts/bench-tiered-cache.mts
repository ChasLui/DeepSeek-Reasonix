// SC-004 / SC-001c bench (deterministic, no API): compares baseline (all tools
// in prefix) vs tiered (MCP deferred) prefix-token cost and models the
// mid-conversation unlock-cost curve. Run: npx tsx scripts/bench-tiered-cache.mts
//
// What needs a LIVE API instead (recipe at the bottom): confirming DeepSeek
// actually returns prompt_cache_hit_tokens on the stable prefix. The token
// economics below are deterministic and are the actionable part of SC-004.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "../src/tokenizer.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";
import { registerChoiceTool } from "../src/tools/choice.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";
import { JobRegistry } from "../src/tools/jobs.js";
import { registerMemoryTools } from "../src/tools/memory.js";
import { registerPlanTool } from "../src/tools/plan.js";
import { registerShellTools } from "../src/tools/shell.js";
import { registerTodoTool } from "../src/tools/todo.js";
import { registerWebTools } from "../src/tools/web.js";
import { activateToolTiering } from "../src/tools/tiering.js";
import type { JSONSchema } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "reasonix-bench-tier-"));
writeFileSync(join(root, "f.txt"), "x\n");

/** Builtin toolset (subset of the real registry — enough for a representative prefix). */
function builtins(): ToolRegistry {
  const r = new ToolRegistry();
  const jobs = new JobRegistry();
  registerFilesystemTools(r, { rootDir: root });
  registerShellTools(r, { rootDir: root, jobs, allowAll: true });
  registerMemoryTools(r, { projectRoot: root });
  registerPlanTool(r);
  registerChoiceTool(r);
  registerTodoTool(r);
  registerWebTools(r);
  return r;
}

/** A GitHub-MCP-shaped tool with a non-trivial schema (the article's ~50k-token bloat source). */
function fakeMcpSchema(i: number): JSONSchema {
  return {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner login." },
      repo: { type: "string", description: "Repository name." },
      query: { type: "string", description: `Search/filter expression for operation ${i}.` },
      state: { type: "string", enum: ["open", "closed", "all"] },
      labels: { type: "array", items: { type: "string" } },
      page: { type: "number", description: "1-based page index." },
      per_page: { type: "number", description: "Items per page, max 100." },
    },
    required: ["owner", "repo"],
  };
}

function addFakeMcp(r: ToolRegistry, server: string, count: number, tier: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${server}_operation_${i}`;
    r.register({
      name,
      description: `${server} API operation ${i}: performs a realistic remote action with several parameters.`,
      parameters: fakeMcpSchema(i),
      tier,
      fn: () => "ok",
    });
    names.push(name);
  }
  return names;
}

function toolTokens(specs: ReturnType<ToolRegistry["specs"]>): number {
  return countTokens(JSON.stringify(specs));
}

const MCP_TOOL_COUNT = Number(process.env.BENCH_MCP_TOOLS ?? 40);
const CACHE_FACTOR = 0.1; // DeepSeek bills cached input at ~10% of the miss rate.
const HISTORY_PER_TURN = Number(process.env.BENCH_HISTORY_PER_TURN ?? 1800); // avg new tokens/turn.

// ---- Prefix sizing (SC-001a/b) -------------------------------------------------
const baseReg = builtins();
addFakeMcp(baseReg, "github", MCP_TOOL_COUNT, 0); // baseline: MCP tools in prefix
const baselinePrefixTok = toolTokens(baseReg.filteredSpecs(PREFIX_MAX_TIER));

const tierReg = builtins();
addFakeMcp(tierReg, "github", MCP_TOOL_COUNT, 2); // tiered: MCP deferred
activateToolTiering(tierReg, { toolTiers: { mcpDefaultTier: 2 } } as never, null);
const tieredPrefixTok = toolTokens(tierReg.filteredSpecs(PREFIX_MAX_TIER));

const perTurnSaving = baselinePrefixTok - tieredPrefixTok;

console.log(`\n=== Prefix tool-spec tokens (${MCP_TOOL_COUNT} MCP tools) ===`);
console.log(`  baseline (all in prefix): ${baselinePrefixTok}`);
console.log(`  tiered   (MCP deferred):  ${tieredPrefixTok}  (incl. search_tools)`);
console.log(`  per-turn prefix saving:   ${perTurnSaving} tokens`);

// ---- SC-001c: cumulative miss-equivalent cost over a session -------------------
// Both modes cache the prefix after turn 1. The baseline pays its larger prefix
// at the cache-hit rate every subsequent turn; the tiered mode pays a SMALLER
// cached prefix but takes a fresh full-prefix miss on each mid-conversation
// unlock (the trade-off). "miss-equivalent tokens" = miss*1 + hit*CACHE_FACTOR.
function cumulativeCost(prefixTok: number, turns: number, unlockTurns: number[]): number {
  let total = 0;
  for (let turn = 1; turn <= turns; turn++) {
    const firstSight = turn === 1 || unlockTurns.includes(turn);
    // prefix billing
    total += firstSight ? prefixTok : prefixTok * CACHE_FACTOR;
    // new history each turn is always a miss (novel tokens), same for both modes
    total += HISTORY_PER_TURN;
  }
  return Math.round(total);
}

const TURNS = 30;
console.log(`\n=== Cumulative miss-equivalent tokens over ${TURNS} turns ===`);
console.log(`  (cache factor ${CACHE_FACTOR}, ${HISTORY_PER_TURN} new history tok/turn)\n`);
console.log(`  unlocks │ baseline │ tiered  │ winner`);
console.log(`  ────────┼──────────┼─────────┼────────`);
for (const k of [0, 1, 3, 6, 10]) {
  // spread k unlocks across the session
  const unlockTurns = Array.from({ length: k }, (_, i) =>
    Math.max(2, Math.round(((i + 1) / (k + 1)) * TURNS)),
  );
  const base = cumulativeCost(baselinePrefixTok, TURNS, []); // baseline never unlocks
  const tiered = cumulativeCost(tieredPrefixTok, TURNS, unlockTurns);
  const winner = tiered < base ? "tiered" : "baseline";
  console.log(
    `  ${String(k).padStart(7)} │ ${String(base).padStart(8)} │ ${String(tiered).padStart(7)} │ ${winner}`,
  );
}

console.log(`\n=== Live-API confirmation recipe (SC-004 cache-hit ratio) ===`);
console.log(`  1. Attach a bloated MCP server and run a multi-tool-call task twice:`);
console.log(`       reasonix run --mcp 'github=...' --transcript /tmp/base.jsonl "<task>"   # toolTiers OFF`);
console.log(`       # add { "toolTiers": { "mcpDefaultTier": 2 } } to ~/.reasonix/config.json, then:`);
console.log(`       reasonix run --mcp 'github=...' --transcript /tmp/tier.jsonl "<task>"   # toolTiers ON`);
console.log(`  2. Compare cache-hit ratio + prefix tokens:`);
console.log(`       reasonix stats           # cross-session cache-hit cell`);
console.log(`       jq -c 'select(.stats.usage) | .stats.usage' /tmp/base.jsonl /tmp/tier.jsonl`);
console.log(`     Expect: stable prefix → hit ratio ~equal; tiered prefix tokens lower by ~${perTurnSaving}.\n`);

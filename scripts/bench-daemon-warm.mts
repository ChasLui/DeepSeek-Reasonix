// Daemon warm-sharing bench (deterministic, no API): the cold-start retrieval-index
// tax a fresh CLI process pays every session vs the warm cache a long-lived daemon
// reuses across sessions. Measures real code-graph + lexical (BM25) build/load on
// this repo. Run: pnpm exec tsx scripts/bench-daemon-warm.mts [workspaceRoot]

import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildCodeGraph } from "../src/index/code-graph/builder.js";
import { loadCodeGraph } from "../src/index/code-graph/loader.js";
import { buildCodeLexicalIndex, openCodeLexicalIndex } from "../src/index/lexical/code.js";

const root = resolve(process.argv[2] ?? ".");

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

const ms = (n: number) => `${n.toFixed(1)}ms`;
const pad = (s: string, w = 13) => s.padStart(w);

console.log(`daemon warm-sharing bench — workspace: ${root}\n`);

// code-graph: cold full build → fresh-process disk reload → same-process cache hit
const cgCold = await timed(() => buildCodeGraph(root, { timeoutMs: 180_000 }));
const cgDisk = await timed(() => loadCodeGraph(root));
const cgCache = await timed(() => loadCodeGraph(root));

// lexical: cold full build → disk open → second open (signature-matched fast path)
const lxCold = await timed(() => buildCodeLexicalIndex(root));
const lxDisk = await timed(() => openCodeLexicalIndex(root));
const lxCache = await timed(() => openCodeLexicalIndex(root));

console.log(
  `code-graph: ${cgCold.value.filesScanned} files, ${cgCold.value.nodes} nodes, ${cgCold.value.edges} edges`,
);
console.log("");
console.log("index            cold build    warm disk-load   warm cache-hit");
console.log(
  `code-graph     ${pad(ms(cgCold.ms))}   ${pad(ms(cgDisk.ms))}    ${pad(ms(cgCache.ms))}`,
);
console.log(
  `lexical(BM25)  ${pad(ms(lxCold.ms))}   ${pad(ms(lxDisk.ms))}    ${pad(ms(lxCache.ms))}`,
);

const coldPer = cgCold.ms + lxCold.ms; // CLI, no persisted index → first find_code cold-builds
const diskPer = cgDisk.ms + lxDisk.ms; // CLI, index on disk → fresh process reloads + deserializes
const warmPer = cgCache.ms + lxCache.ms; // daemon, same process → cache hit

console.log("\nper-session retrieval-readiness tax (code-graph + lexical):");
console.log(`  CLI, no prior index (cold build):  ${ms(coldPer)}`);
console.log(`  CLI, on-disk index (reload):       ${ms(diskPer)}`);
console.log(`  daemon, warm in-process cache:     ${ms(warmPer)}`);

for (const N of [5, 20]) {
  const cliCold = coldPer * N; // worst case: nothing persisted, every session cold-builds
  const cliDisk = coldPer + diskPer * (N - 1); // build once, reload per fresh process
  const daemon = coldPer + warmPer * (N - 1); // build once, warm cache thereafter
  const speedup = cliDisk / Math.max(daemon, 0.01);
  console.log(`\nover ${N} sessions in one workspace:`);
  console.log(`  CLI (cold each):    ${ms(cliCold)}`);
  console.log(`  CLI (disk reload):  ${ms(cliDisk)}`);
  console.log(
    `  daemon (warm):      ${ms(daemon)}  →  ${speedup.toFixed(1)}× vs disk-reload, saves ${ms(cliDisk - daemon)}`,
  );
}

console.log("\nnote: the MCP transport handshake (serena) is amortized too — the daemon");
console.log("handshakes once per workspace (NF-004) vs once per CLI process. Not measured");
console.log("here (needs the live server) but adds further to the per-session tax.");

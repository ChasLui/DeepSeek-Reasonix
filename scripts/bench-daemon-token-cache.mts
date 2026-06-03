// Daemon token-cache bench (deterministic, no API call): does daemon session
// routing preserve DeepSeek prompt-cache eligibility? Measures the cache-eligible
// immutable-prefix token count and verifies (a) two daemon sessions in one
// workspace produce byte-identical prefixes and (b) the daemon prefix is
// byte-identical to an in-process buildSession (NF-005) — both required for the
// KV-cache prefix to actually hit on every turn after the first.
// Run: npx tsx scripts/bench-daemon-token-cache.mts [workspaceRoot]

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSession } from "../src/cli/commands/acp.js";
import { connectDaemon } from "../src/daemon/client.js";
import { DaemonHost } from "../src/daemon/host.js";
import { listenDaemon } from "../src/daemon/server-listen.js";
import { countTokens } from "../src/tokenizer.js";

const root = resolve(process.argv[2] ?? ".");
const sock = join(mkdtempSync(join(tmpdir(), "reasonix-bench-tc-")), "d.sock");

async function main(): Promise<void> {
  // in-process baseline — no MCP, matching the daemon's empty default pool.
  const inproc = await buildSession({
    rootDir: root,
    mcpSpecs: [],
    bridgeMcp: async () => [],
  });
  const ipSys = inproc.loop.prefix.system;
  const ipTools = JSON.stringify(inproc.loop.prefix.toolSpecs);

  // daemon path — two sessions in the same workspace, over a real socket.
  const host = new DaemonHost({ defaultDir: root });
  const server = await listenDaemon(host, sock);
  const client = await connectDaemon(sock);
  await client.initialize();
  const s1 = await client.stats(await client.newSession(root));
  const s2 = await client.stats(await client.newSession(root));
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
  await host.closeAll();

  const det = s1.prefixSystem === s2.prefixSystem && s1.prefixToolSpecs === s2.prefixToolSpecs;
  const nf005 = s1.prefixSystem === ipSys && s1.prefixToolSpecs === ipTools;

  const sysTok = countTokens(s1.prefixSystem);
  const toolTok = countTokens(s1.prefixToolSpecs);
  const total = sysTok + toolTok;

  console.log(`daemon token-cache bench — workspace: ${root}\n`);
  console.log("cache-eligible immutable prefix (DeepSeek caches this byte-prefix):");
  console.log(`  system prompt:  ${sysTok} tokens`);
  console.log(`  tool specs:     ${toolTok} tokens`);
  console.log(
    `  total prefix:   ${total} tokens  ← prompt_cache_hit on every turn after the first\n`,
  );

  console.log("Pillar-1 invariants (required for the cache to actually hit):");
  console.log(
    `  two daemon sessions, same workspace → byte-identical prefix:  ${det ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  daemon prefix == in-process buildSession (NF-005):            ${nf005 ? "PASS" : "FAIL"}`,
  );

  // DeepSeek economics: cache-hit prefix tokens bill at ~0.1x of cache-miss tokens.
  const HIT_RATIO = 0.1;
  for (const turns of [10, 50]) {
    const reuse = turns - 1; // first turn is a miss (writes the prefix); rest hit
    const noCache = total * turns;
    const withCache = total + total * HIT_RATIO * reuse;
    const saved = noCache - withCache;
    console.log(`\nover ${turns} turns (prefix re-sent each turn, ${total} tok):`);
    console.log(`  prefix tokens billed without cache:  ${Math.round(noCache)} tok`);
    console.log(
      `  prefix tokens billed with cache:     ${Math.round(withCache)} tok  (${Math.round(saved)} tok / ${Math.round((saved / noCache) * 100)}% saved)`,
    );
  }

  console.log("\nnote: this proves daemon routing keeps the prefix byte-stable so the");
  console.log("KV-cache CAN hit. Confirming DeepSeek actually returns");
  console.log("prompt_cache_hit_tokens needs a live API turn (run a real `reasonix run`");
  console.log("with DEEPSEEK_API_KEY, then read the usage stats).");
  process.exit(det && nf005 ? 0 : 1);
}

void main();

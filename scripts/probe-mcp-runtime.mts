import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { normalizeMcpConfig, readConfig, type ReasonixConfig } from "../src/config.js";
import { McpClient } from "../src/mcp/client.js";
import { loadDotMcpJson } from "../src/mcp/dot-mcp-json.js";
import { preflightStdioSpec } from "../src/mcp/preflight.js";
import { specToRaw, type McpServerSpec } from "../src/mcp/spec.js";
import { buildTransportFromSpec } from "../src/mcp/transport-from-spec.js";

interface ProbeResult {
  generatedAt: string;
  projectRoot: string;
  outputDir: string;
  servers: Array<ReturnType<typeof redactSpec>>;
  listResourcesSessionHits: number;
  samples: Array<{
    name: string;
    raw: string;
    attempts: Array<
      | {
          ok: true;
          elapsedMs: number;
          tools: number;
          protocolVersion: string;
          serverInfo: { name: string; version: string };
          toolsListChanged: boolean;
        }
      | { ok: false; elapsedMs: number; error: string }
    >;
  }>;
}

const args = new Set(process.argv.slice(2));

if (args.has("--watch-feasibility")) {
  const result = await probeWatchFeasibility();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const projectRoot = process.cwd();
const outputDir = join(tmpdir(), `mcp-attest-${timestamp()}`);
await mkdir(outputDir, { recursive: true });
const config = readMergedConfig(projectRoot);
const specs = normalizeMcpConfig(config).filter((spec) => spec.disabled !== true);
const samples = [];
for (const spec of pickSampleSpecs(specs)) {
  samples.push(await sampleServer(spec));
}
const result: ProbeResult = {
  generatedAt: new Date().toISOString(),
  projectRoot,
  outputDir,
  servers: specs.map(redactSpec),
  listResourcesSessionHits: countSessionHits(),
  samples,
};
await writeFile(join(outputDir, "probe.json"), `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${join(outputDir, "probe.json")}\n`);
process.stdout.write(`${JSON.stringify(summary(result), null, 2)}\n`);

function readMergedConfig(projectRoot: string): ReasonixConfig {
  const cfg = readConfig();
  const project = loadDotMcpJson(projectRoot);
  if (!project) return cfg;
  return { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), ...project } };
}

function redactSpec(spec: McpServerSpec): {
  name: string | null;
  transport: McpServerSpec["transport"];
  command?: string;
  argsCount?: number;
  urlHost?: string;
  envKeys?: string[];
  headerKeys?: string[];
} {
  if (spec.transport === "stdio") {
    return {
      name: spec.name,
      transport: spec.transport,
      command: basename(spec.command),
      argsCount: spec.args.length,
      envKeys: Object.keys(spec.env ?? {}).sort(),
    };
  }
  return {
    name: spec.name,
    transport: spec.transport,
    urlHost: safeHost(spec.url),
    headerKeys: Object.keys(spec.headers ?? {}).sort(),
  };
}

function pickSampleSpecs(specs: readonly McpServerSpec[]): McpServerSpec[] {
  const out: McpServerSpec[] = [];
  const serena = specs.find((spec) => spec.name === "serena");
  if (serena) out.push(serena);
  for (const spec of specs) {
    if (out.length >= 3) break;
    if (out.includes(spec)) continue;
    out.push(spec);
  }
  return out;
}

async function sampleServer(spec: McpServerSpec): Promise<ProbeResult["samples"][number]> {
  const raw = specToRaw(spec);
  const name = spec.name ?? "anon";
  const attempts: ProbeResult["samples"][number]["attempts"] = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    let client: McpClient | null = null;
    try {
      if (spec.transport === "stdio") preflightStdioSpec(spec);
      client = new McpClient({ transport: buildTransportFromSpec(spec), requestTimeoutMs: 15_000 });
      await client.initialize();
      const listed = await client.listTools();
      attempts.push({
        ok: true,
        elapsedMs: Date.now() - started,
        tools: listed.tools.length,
        protocolVersion: client.protocolVersion,
        serverInfo: client.serverInfo,
        toolsListChanged: client.serverCapabilities.tools?.listChanged === true,
      });
    } catch (err) {
      attempts.push({ ok: false, elapsedMs: Date.now() - started, error: (err as Error).message });
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
  return { name, raw, attempts };
}

function countSessionHits(): number {
  const sessionsDir = join(homedir(), ".reasonix", "sessions");
  const result = spawnSync("rg", ["--count-matches", "list_resources|resources/list", sessionsDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 && result.status !== 1) return 0;
  return result.stdout
    .split("\n")
    .map((line) => Number(line.split(":").pop() ?? 0))
    .filter(Number.isFinite)
    .reduce((sum, count) => sum + count, 0);
}

async function probeWatchFeasibility(): Promise<{
  path: string;
  writes: number;
  events: number;
  platform: NodeJS.Platform;
}> {
  const dir = join(tmpdir(), `mcp-watch-${timestamp()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".mcp.json");
  await writeFile(path, "{}\n", "utf8");
  let events = 0;
  const watcher = watch(path, () => {
    events++;
  });
  for (let i = 0; i < 3; i++) {
    await writeFile(path, `${JSON.stringify({ i })}\n`, "utf8");
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  watcher.close();
  return { path, writes: 3, events, platform: process.platform };
}

function summary(result: ProbeResult): {
  servers: number;
  successfulSamples: number;
  listChangedAdvertised: number;
  listResourcesSessionHits: number;
} {
  const okAttempts = result.samples.flatMap((sample) =>
    sample.attempts.filter((attempt) => attempt.ok),
  );
  return {
    servers: result.servers.length,
    successfulSamples: okAttempts.length,
    listChangedAdvertised: okAttempts.filter((attempt) => attempt.toolsListChanged).length,
    listResourcesSessionHits: result.listResourcesSessionHits,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpClient } from "./client.js";
import type { StdioMcpSpec } from "./spec.js";
import type { McpTool } from "./types.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const EAGER_DRIFT_TIMEOUT_MS = 3000;
export interface CacheEntry {
  savedAt: number;
  specHash: string;
  tools: McpTool[];
  serverInfoVersion: string;
  protocolVersion: string;
  capabilityDigest: string;
}

interface ValidEntry {
  entry: CacheEntry;
  path: string;
}

// Shared sync validation: existence, TTL, spec hash, sync drift. Returns the
// entry + path, or null on any miss.
function readValidEntry(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> | undefined },
  client: McpClient,
): ValidEntry | null {
  ensureCachePermissions();
  const path = cachePath(serverName);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    if (Date.now() - entry.savedAt > TTL_MS) return null;
    if (entry.specHash !== specHash(spec)) return null;
    if (!verifyDriftSync(client, entry)) return null;
    return { entry, path };
  } catch {
    return null;
  }
}

export function loadMcpToolCache(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> | undefined },
  client: McpClient,
): McpTool[] | null {
  const valid = readValidEntry(serverName, spec, client);
  if (!valid) return null;
  // Fire-and-forget: a tools/list change only reflects on the NEXT startup.
  void verifyDriftAsync(client, valid.entry).then(
    (ok) => !ok && rmSync(valid.path, { force: true }),
  );
  return valid.entry.tools;
}

// Eager drift gate (Slice 2 / scheme 10): await the async tools/list check
// BEFORE the prefix is built. Drift -> delete cache + return null so the caller
// rebuilds from a live tools/list. Per-server timeout falls back to fire-and-forget (FR-004).
export async function loadMcpToolCacheEager(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> | undefined },
  client: McpClient,
  timeoutMs: number = EAGER_DRIFT_TIMEOUT_MS,
): Promise<McpTool[] | null> {
  const valid = readValidEntry(serverName, spec, client);
  if (!valid) return null;
  const ms = Number(process.env["REASONIX_MCP_EAGER_DRIFT_TIMEOUT_MS"]) || timeoutMs;
  const driftP = verifyDriftAsync(client, valid.entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const verdict = await Promise.race([driftP, timeoutP]);
  if (timer) clearTimeout(timer);
  if (verdict === "timeout") {
    // Eager budget exhausted — preserve the fire-and-forget rmSync for next start.
    void driftP.then((ok) => !ok && rmSync(valid.path, { force: true }));
    return valid.entry.tools;
  }
  if (!verdict) {
    rmSync(valid.path, { force: true });
    return null;
  }
  return valid.entry.tools;
}

export function saveMcpToolCache(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> | undefined },
  client: McpClient,
  tools: readonly McpTool[],
): void {
  ensureCachePermissions();
  const entry: CacheEntry = {
    savedAt: Date.now(),
    specHash: specHash(spec),
    tools: [...tools],
    serverInfoVersion: client.serverInfo.version,
    protocolVersion: client.protocolVersion,
    capabilityDigest: capabilityDigest(client),
  };
  writeFileSync(cachePath(serverName), `${JSON.stringify(entry, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(cachePath(serverName), 0o600);
}

export function verifyDriftSync(client: McpClient, entry: CacheEntry): boolean {
  return (
    entry.serverInfoVersion === client.serverInfo.version &&
    entry.protocolVersion === client.protocolVersion &&
    entry.capabilityDigest === capabilityDigest(client)
  );
}

export async function verifyDriftAsync(client: McpClient, entry: CacheEntry): Promise<boolean> {
  if (!verifyDriftSync(client, entry)) return false;
  try {
    const listed = await client.listTools();
    return toolsDigest(entry.tools) === toolsDigest(listed.tools);
  } catch {
    return true;
  }
}

function toolsDigest(tools: readonly McpTool[]): string {
  return hash(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    })),
  );
}

function ensureCachePermissions(): void {
  mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
  chmodSync(cacheDir(), 0o700);
  if (!existsSync(saltPath())) {
    writeFileSync(saltPath(), randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  chmodSync(saltPath(), 0o600);
}

function cachePath(serverName: string): string {
  return join(cacheDir(), `${safeServerName(serverName)}.json`);
}

function cacheDir(): string {
  return join(process.env["REASONIX_HOME"] ?? join(homedir(), ".reasonix"), "mcp-cache");
}

function saltPath(): string {
  return join(process.env["REASONIX_HOME"] ?? join(homedir(), ".reasonix"), ".cache-salt");
}

function specHash(spec: StdioMcpSpec & { env?: Record<string, string> | undefined }): string {
  return hash({
    command: spec.command,
    args: spec.args,
    env: spec.env ?? {},
    SALT: readFileSync(saltPath(), "utf8"),
  });
}

function capabilityDigest(client: McpClient): string {
  return hash(client.serverCapabilities);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function safeServerName(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9._-]/g, "_") || "server";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

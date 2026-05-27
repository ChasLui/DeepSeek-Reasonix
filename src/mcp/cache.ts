import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpClient } from "./client.js";
import type { StdioMcpSpec } from "./spec.js";
import type { McpTool } from "./types.js";

const TTL_MS = 24 * 60 * 60 * 1000;
export interface CacheEntry {
  savedAt: number;
  specHash: string;
  tools: McpTool[];
  serverInfoVersion: string;
  protocolVersion: string;
  capabilityDigest: string;
}

export function loadMcpToolCache(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> },
  client: McpClient,
): McpTool[] | null {
  ensureCachePermissions();
  const path = cachePath(serverName);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    if (Date.now() - entry.savedAt > TTL_MS) return null;
    if (entry.specHash !== specHash(spec)) return null;
    if (!verifyDriftSync(client, entry)) return null;
    void verifyDriftAsync(client, entry).then((ok) => !ok && rmSync(path, { force: true }));
    return entry.tools;
  } catch {
    return null;
  }
}

export function saveMcpToolCache(
  serverName: string,
  spec: StdioMcpSpec & { env?: Record<string, string> },
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
  return join(process.env.REASONIX_HOME ?? join(homedir(), ".reasonix"), "mcp-cache");
}

function saltPath(): string {
  return join(process.env.REASONIX_HOME ?? join(homedir(), ".reasonix"), ".cache-salt");
}

function specHash(spec: StdioMcpSpec & { env?: Record<string, string> }): string {
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

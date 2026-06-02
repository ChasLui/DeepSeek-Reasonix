/** Per-workspace MCP transport pool — initializes each server's stdio child once per workspace and bridges it into every session's own registry, keeping children warm across sessions. */

import { normalizeMcpConfig, readConfig } from "../config.js";
import { McpClient } from "../mcp/client.js";
import { preflightStdioSpec } from "../mcp/preflight.js";
import { bridgeMcpTools } from "../mcp/registry.js";
import { buildTransportFromSpec } from "../mcp/transport-from-spec.js";
import type { ToolRegistry } from "../tools.js";
import { applyMcpServerTier, resolveMcpDefaultTier } from "../tools/tiering.js";

interface PooledServer {
  client: McpClient;
  label: string;
  prefix: string;
}

function resolveMcpPrefix(
  specName: string | null | undefined,
  specCount: number,
  globalPrefix: string | undefined,
): string {
  if (specName) return `${specName}_`;
  if (specCount === 1 && globalPrefix) return globalPrefix;
  return "";
}

export class McpPool {
  // Keyed by workspace root. The Promise is shared so concurrent first-sessions
  // in one workspace handshake the children exactly once (NF-004).
  private readonly byRoot = new Map<string, Promise<PooledServer[]>>();

  get workspaceCount(): number {
    return this.byRoot.size;
  }

  private ensureWorkspace(
    rootDir: string,
    specs: string[],
    globalPrefix: string | undefined,
  ): Promise<PooledServer[]> {
    const existing = this.byRoot.get(rootDir);
    if (existing) return existing;
    const init = this.initWorkspace(specs, globalPrefix);
    this.byRoot.set(rootDir, init);
    return init;
  }

  private async initWorkspace(
    specs: string[],
    globalPrefix: string | undefined,
  ): Promise<PooledServer[]> {
    const servers: PooledServer[] = [];
    if (specs.length === 0) return servers;
    const cfg = readConfig();
    const normalized = normalizeMcpConfig(cfg, specs);
    for (const spec of normalized) {
      if (spec.disabled) continue;
      const label = spec.name ?? "anon";
      let client: McpClient | undefined;
      try {
        if (spec.transport === "stdio") preflightStdioSpec(spec);
        const transport = buildTransportFromSpec(spec);
        client = new McpClient({ transport });
        await client.initialize();
        servers.push({
          client,
          label,
          prefix: resolveMcpPrefix(spec.name, normalized.length, globalPrefix),
        });
      } catch (err) {
        await client?.close().catch(() => undefined);
        process.stderr.write(`daemon MCP "${label}" failed: ${(err as Error).message}\n`);
      }
    }
    return servers;
  }

  /** Bridge the workspace's warm servers into one session's registry. Each session gets its own wrappers over the shared clients — Pillar-1 prefix stays per-session. */
  async bridgeInto(
    rootDir: string,
    specs: string[],
    globalPrefix: string | undefined,
    tools: ToolRegistry,
  ): Promise<void> {
    const servers = await this.ensureWorkspace(rootDir, specs, globalPrefix);
    if (servers.length === 0) return;
    const cfg = readConfig();
    const mcpDefaultTier = resolveMcpDefaultTier(cfg);
    for (const server of servers) {
      const bridge = await bridgeMcpTools(server.client, {
        registry: tools,
        namePrefix: server.prefix,
        serverName: server.label,
        mcpDefaultTier,
      });
      applyMcpServerTier(tools, bridge.registeredNames, cfg);
    }
  }

  async closeAll(): Promise<void> {
    const closes: Promise<unknown>[] = [];
    for (const init of this.byRoot.values()) {
      const servers = await init.catch(() => [] as PooledServer[]);
      for (const server of servers) closes.push(server.client.close().catch(() => undefined));
    }
    this.byRoot.clear();
    await Promise.all(closes);
  }
}

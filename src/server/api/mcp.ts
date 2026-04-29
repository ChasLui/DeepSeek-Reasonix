/** Spec mutations don't auto-reload — adding a server shifts the system prefix and zeroes the next cache hit. */

import { readConfig, writeConfig } from "../../config.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface SpecBody {
  spec?: unknown;
}
interface InvokeBody {
  server?: unknown;
  tool?: unknown;
  args?: unknown;
}

function parseBody<T>(raw: string): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

export async function handleMcp(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  // Bridged-server view (live).
  if (method === "GET" && rest.length === 0) {
    const servers = (ctx.mcpServers ?? []).map((s) => ({
      label: s.label,
      spec: s.spec,
      toolCount: s.toolCount,
      protocolVersion: s.report.protocolVersion,
      serverInfo: s.report.serverInfo,
      capabilities: s.report.capabilities,
      tools: s.report.tools.supported ? s.report.tools.items : [],
      resources: s.report.resources.supported ? s.report.resources.items : [],
      prompts: s.report.prompts.supported ? s.report.prompts.items : [],
      instructions: s.report.instructions ?? null,
    }));
    return {
      status: 200,
      body: {
        servers,
        canHotReload: Boolean(ctx.reloadMcp),
        canInvoke: Boolean(ctx.invokeMcpTool),
      },
    };
  }

  // Persisted spec list — what config.mcp[] holds. May differ from
  // bridged set (a recent edit hasn't been reloaded yet).
  if (method === "GET" && rest[0] === "specs") {
    const cfg = readConfig(ctx.configPath);
    return { status: 200, body: { specs: cfg.mcp ?? [] } };
  }

  if (method === "POST" && rest[0] === "specs") {
    const { spec } = parseBody<SpecBody>(body);
    if (typeof spec !== "string" || !spec.trim()) {
      return { status: 400, body: { error: "spec (non-empty string) required" } };
    }
    const cfg = readConfig(ctx.configPath);
    const list = cfg.mcp ?? [];
    if (list.includes(spec)) {
      return { status: 200, body: { added: false, alreadyPresent: true } };
    }
    cfg.mcp = [...list, spec.trim()];
    writeConfig(cfg, ctx.configPath);
    ctx.audit?.({ ts: Date.now(), action: "add-mcp-spec", payload: { spec } });
    return { status: 200, body: { added: true, requiresRestart: !ctx.reloadMcp } };
  }

  if (method === "DELETE" && rest[0] === "specs") {
    const { spec } = parseBody<SpecBody>(body);
    if (typeof spec !== "string") {
      return { status: 400, body: { error: "spec (string) required" } };
    }
    const cfg = readConfig(ctx.configPath);
    const list = cfg.mcp ?? [];
    if (!list.includes(spec)) {
      return { status: 200, body: { removed: false } };
    }
    cfg.mcp = list.filter((s) => s !== spec);
    writeConfig(cfg, ctx.configPath);
    ctx.audit?.({ ts: Date.now(), action: "remove-mcp-spec", payload: { spec } });
    return { status: 200, body: { removed: true, requiresRestart: !ctx.reloadMcp } };
  }

  if (method === "POST" && rest[0] === "reload") {
    if (!ctx.reloadMcp) {
      return {
        status: 503,
        body: {
          error:
            "live MCP reload not wired in this session — restart `reasonix code` to apply spec edits.",
        },
      };
    }
    const count = await ctx.reloadMcp();
    return { status: 200, body: { reloaded: true, count } };
  }

  if (method === "POST" && rest[0] === "invoke") {
    if (!ctx.invokeMcpTool) {
      return {
        status: 503,
        body: { error: "MCP invocation requires an attached session." },
      };
    }
    const { server, tool, args } = parseBody<InvokeBody>(body);
    if (typeof server !== "string" || typeof tool !== "string") {
      return { status: 400, body: { error: "server + tool (strings) required" } };
    }
    try {
      const result = await ctx.invokeMcpTool(
        server,
        tool,
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
      );
      return { status: 200, body: { result } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  return { status: 405, body: { error: `method ${method} not supported on this path` } };
}

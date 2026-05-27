import * as fs from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { normalizeMcpConfig, readConfig } from "../../config.js";
import { t } from "../../i18n/index.js";
import type { CacheFirstLoop } from "../../loop.js";
import { loadMcpToolCache, saveMcpToolCache } from "../../mcp/cache.js";
import { McpClient } from "../../mcp/client.js";
import { loadDotMcpJson } from "../../mcp/dot-mcp-json.js";
import { classifyToolListDrift } from "../../mcp/drift.js";
import { type InspectionReport, inspectMcpServer } from "../../mcp/inspect.js";
import { preflightStdioSpec } from "../../mcp/preflight.js";
import { reconnectMcpServer } from "../../mcp/reconnect.js";
import {
  type BridgeEnv,
  type McpClientHost,
  bridgeMcpPrompts,
  bridgeMcpResources,
  bridgeMcpTools,
  registerSingleMcpTool,
} from "../../mcp/registry.js";
import {
  getMcpServerEnv,
  getMcpServerHeaders,
  overlayMatchedSpec,
  parseMcpSpec,
  specToRaw,
} from "../../mcp/spec.js";
import { buildMcpServerSummary } from "../../mcp/summary.js";
import { buildTransportFromSpec } from "../../mcp/transport-from-spec.js";
import type { McpTool } from "../../mcp/types.js";
import type { ToolRegistry } from "../../tools.js";
import { isToolSelected } from "../../tools/toolset.js";
import type { ToolSpec } from "../../types.js";
import { type McpLifecycleEvent, formatMcpLifecycleEvent } from "../ui/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../ui/mcp-toast.js";
import type { McpServerSummary } from "../ui/slash.js";

export interface ProgressInfo {
  toolName: string;
  progress: number;
  total?: number;
  message?: string;
}

interface SpecRecord {
  spec: string;
  client: McpClient;
  host: McpClientHost;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bridgeEnv: BridgeEnv;
  mcpTools: McpTool[];
  summary: McpServerSummary;
  /** Names of bridged tools — used for hot-unbridge. */
  registeredNames: string[];
  /** ToolSpec snapshots captured AFTER bridge — handed to loop.prefix.addTool on hot-add. */
  registeredSpecs: ToolSpec[];
  notificationDisposers: Array<() => void>;
}

export interface RuntimeContext {
  getTools: () => ToolRegistry | undefined;
  getMcpPrefix: () => string | undefined;
  getRequestedCount: () => number;
  progressSink: { current: ((info: ProgressInfo) => void) | null };
  projectRoot: () => string;
  /** Session toolset selection — bridged MCP tools not in this set (and not essential) are gated out of the prefix. Absent / returns null ⟹ no gating. */
  getToolSelection?: () => ReadonlySet<string> | null;
}

export type McpLifecycleNotice =
  | { kind: "handshake"; name: string }
  | {
      kind: "connected";
      name: string;
      tools: number;
      resources: number;
      prompts: number;
      ms: number;
    }
  | { kind: "disabled"; name: string }
  | { kind: "failed"; name: string; reason: string }
  | { kind: "unhealthy"; serverName: string; reason: string }
  | { kind: "permanently_failed"; name: string; reason: string }
  | { kind: "slow"; serverName: string; p95Ms: number; sampleSize: number }
  | { kind: "tools-ready"; name: string; tools: number; ms: number }
  | { kind: "warn"; name: string; reason: string };

export type McpLifecycleSink = (notice: McpLifecycleNotice) => void;

export const stderrLifecycleSink: McpLifecycleSink = (n) => {
  if (n.kind === "slow") {
    process.stderr.write(
      `${formatMcpSlowToast({ name: n.serverName, p95Ms: n.p95Ms, sampleSize: n.sampleSize })}\n`,
    );
    return;
  }
  if (n.kind === "failed") {
    process.stderr.write(
      `${formatMcpLifecycleEvent({ state: "failed", name: n.name, reason: n.reason })}\n  → ${t("mcpLifecycle.failedSetupHint")}\n`,
    );
    return;
  }
  if (n.kind === "unhealthy") {
    process.stderr.write(`MCP ${n.serverName} unhealthy: ${n.reason}\n`);
    return;
  }
  if (n.kind === "permanently_failed") {
    process.stderr.write(`MCP ${n.name} permanently_failed: ${n.reason}\n`);
    return;
  }
  if (n.kind === "connected") {
    process.stderr.write(
      `${formatMcpLifecycleEvent({
        state: "connected",
        name: n.name,
        tools: n.tools,
        resources: n.resources,
        prompts: n.prompts,
        ms: n.ms,
      })}\n`,
    );
    return;
  }
  if (n.kind === "tools-ready") {
    process.stderr.write(
      `${formatMcpLifecycleEvent({ state: "tools-ready", name: n.name, tools: n.tools, ms: n.ms })}\n`,
    );
    return;
  }
  if (n.kind === "warn") {
    process.stderr.write(
      `${formatMcpLifecycleEvent({ state: "warn", name: n.name, reason: n.reason })}\n`,
    );
    return;
  }
  // handshake / disabled — no extra fields needed
  process.stderr.write(
    `${formatMcpLifecycleEvent({ state: n.kind as "handshake" | "disabled", name: n.name })}\n`,
  );
};

export interface McpFailure {
  spec: string;
  name: string;
  reason: string;
  at: number;
}

export interface McpRuntime {
  size(): number;
  specs(): string[];
  summaries(): McpServerSummary[];
  /** Last bridge failure per spec — drives the "未桥接" reason shown in the dashboard. */
  failures(): McpFailure[];
  addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }>;
  removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean>;
  reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }>;
  refilter(loop?: CacheFirstLoop): Promise<{ added: string[]; removed: string[] }>;
  closeAll(): Promise<void>;
  /** Replace the sink that lifecycle events flow through — App.tsx swaps this in on mount so toasts land in the alt-screen UI instead of corrupting it via stderr. */
  setLifecycleSink(sink: McpLifecycleSink): void;
}

export function createMcpRuntime(ctx: RuntimeContext): McpRuntime {
  const records = new Map<string, SpecRecord>();
  const insertionOrder: string[] = [];
  const failureMap = new Map<string, McpFailure>();
  const lastReconnectAt = new Map<string, number>();
  const reconnectFailures = new Map<string, number>();
  const permanentlyFailed = new Set<string>();
  let sink: McpLifecycleSink = stderrLifecycleSink;
  let _queue: Promise<void> = Promise.resolve();
  let mcpWatcher: FSWatcher | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;

  async function addSpecImpl(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }> {
    ensureWatcher(loop);
    if (records.has(raw)) {
      return { ok: true, summary: records.get(raw)!.summary };
    }
    failureMap.delete(raw);
    const tools = ctx.getTools();
    if (!tools) return { ok: false, reason: "no tool registry available" };
    const cfg = readMergedConfig();
    const normalized = normalizeMcpConfig(cfg);
    let label = "anon";
    let mcp: McpClient | undefined;
    // Per-server readiness gate — tool dispatches via the bridge await
    // this before calling into `live.callTool`. Resolved on `connected`,
    // rejected on `failed`, so a tool invoked mid-handshake waits
    // (capped by `bridgeMcpTools`'s `readyTimeoutMs`) instead of
    // surfacing a transport error.
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Avoid unhandledRejection if no consumer awaits `ready` yet.
    ready.catch(() => undefined);
    try {
      const parsed = parseMcpSpec(raw);
      label = parsed.name ?? "anon";
      const matched = parsed.name ? normalized.find((s) => s.name === parsed.name) : undefined;
      const spec = overlayMatchedSpec(parsed, matched);
      const env = getMcpServerEnv(spec);
      const headers = getMcpServerHeaders(spec);
      if (spec.disabled) {
        sink({ kind: "disabled", name: label });
        rejectReady(new Error(`MCP server "${label}" is disabled`));
        failureMap.set(raw, {
          spec: raw,
          name: label,
          reason: "disabled by user",
          at: Date.now(),
        });
        return { ok: false, reason: "disabled by user" };
      }
      sink({ kind: "handshake", name: label });
      const t0 = Date.now();
      const namePrefix = spec.name
        ? `${spec.name}_`
        : ctx.getRequestedCount() === 1 && ctx.getMcpPrefix()
          ? (ctx.getMcpPrefix() as string)
          : "";
      if (spec.transport === "stdio") preflightStdioSpec(spec);
      const transport = buildTransportFromSpec(spec);
      mcp = new McpClient({ transport });
      await mcp.initialize({ signal });
      const host: McpClientHost = { client: mcp };
      const selection = ctx.getToolSelection?.() ?? null;
      const cachedTools = spec.transport === "stdio" ? loadMcpToolCache(label, spec, mcp) : null;
      const bridge = await bridgeMcpTools(mcp, {
        registry: tools,
        toolFilter: selection === null ? undefined : (name) => isToolSelected(name, selection),
        mcpToolsOverride: cachedTools ?? undefined,
        namePrefix,
        serverName: label,
        host,
        ready,
        onProgress: (info) => ctx.progressSink.current?.(info),
        onSlow: (info) =>
          sink({
            kind: "slow",
            serverName: info.serverName,
            p95Ms: info.p95Ms,
            sampleSize: info.sampleSize,
          }),
        onUnhealthy: (info) => {
          sink({
            kind: "unhealthy",
            serverName: info.serverName,
            reason: info.reason,
          });
          void enqueueMutation(`self-heal:${raw}`, label, () => handleUnhealthy(raw, label, loop));
        },
      });
      if (spec.transport === "stdio" && cachedTools === null) {
        saveMcpToolCache(label, spec, mcp, bridge.mcpTools);
      }
      const slice4Enabled = process.env.REASONIX_MCP_RESOURCES_BRIDGE === "1";
      const resourcesBridge = slice4Enabled
        ? await bridgeMcpResources(mcp, { registry: tools, serverName: label })
        : { registry: tools, registeredNames: [], mcpTools: [], skipped: [] };
      const promptsBridge = slice4Enabled
        ? await bridgeMcpPrompts(mcp, { registry: tools, serverName: label })
        : { registry: tools, registeredNames: [], mcpTools: [], skipped: [] };
      let registeredNames = [
        ...bridge.registeredNames,
        ...resourcesBridge.registeredNames,
        ...promptsBridge.registeredNames,
      ];
      if (selection !== null) {
        registeredNames = registeredNames.filter((name) => {
          if (isToolSelected(name, selection)) return true;
          tools.unregister(name);
          return false;
        });
      }
      // Tools are registered — record the bridge NOW so the UI shows
      // "bridged" even if later non-critical steps (inspect, hot-add) fail.
      const ms = Date.now() - t0;
      const allSpecs = tools.specs();
      const registeredSpecs = allSpecs.filter((s) => registeredNames.includes(s.function.name));
      // Create a provisional record immediately (tools already usable).
      records.set(raw, {
        spec: raw,
        client: mcp,
        host,
        env,
        headers,
        bridgeEnv: bridge.env,
        mcpTools: bridge.mcpTools,
        summary: buildMcpServerSummary({
          label,
          spec: raw,
          toolCount: registeredNames.length,
          report: {
            protocolVersion: mcp.protocolVersion,
            serverInfo: mcp.serverInfo,
            capabilities: mcp.serverCapabilities ?? {},
            tools: { supported: true, items: [] },
            resources: { supported: false, reason: "still inspecting" },
            prompts: { supported: false, reason: "still inspecting" },
            elapsedMs: ms,
          },
          host,
          bridgeEnv: bridge.env,
        }),
        registeredNames,
        registeredSpecs,
        notificationDisposers: bindNotificationHandlers(raw, label, mcp, loop),
      });
      insertionOrder.push(raw);
      resolveReady();
      sink({
        kind: "tools-ready",
        name: label,
        tools: registeredNames.length,
        ms,
      });

      // Non-critical: inspect + hot-add. Failures here don't un-bridge.
      let report: InspectionReport;
      try {
        report = await inspectMcpServer(mcp);
      } catch {
        report = {
          protocolVersion: mcp.protocolVersion,
          serverInfo: mcp.serverInfo,
          capabilities: mcp.serverCapabilities ?? {},
          tools: { supported: true, items: [] },
          resources: { supported: false, reason: "inspect failed" },
          prompts: { supported: false, reason: "inspect failed" },
          elapsedMs: 0,
        };
      }
      const resourceCount = report.resources.supported ? report.resources.items.length : 0;
      const promptCount = report.prompts.supported ? report.prompts.items.length : 0;
      // Re-emit with full inspection data (the provisional event reported 0).
      sink({
        kind: "connected",
        name: label,
        tools: bridge.registeredNames.length,
        resources: resourceCount,
        prompts: promptCount,
        ms,
      });
      const summary = buildMcpServerSummary({
        label,
        spec: raw,
        toolCount: registeredNames.length,
        report,
        host,
        bridgeEnv: bridge.env,
      });
      // Replace the provisional record with the fully-inspected summary.
      records.set(raw, {
        spec: raw,
        client: mcp,
        host,
        env,
        headers,
        bridgeEnv: bridge.env,
        mcpTools: bridge.mcpTools,
        summary,
        registeredNames,
        registeredSpecs,
        notificationDisposers: records.get(raw)?.notificationDisposers ?? [],
      });
      // Hot-add: shift the prefix so the live loop sees the new tools
      // on the very next turn. Each addTool is one cache-miss turn.
      if (loop)
        for (const s of registeredSpecs)
          try {
            loop.prefix.addTool(s);
          } catch (err) {
            sink({
              kind: "warn",
              name: label,
              reason: `addTool failed for ${s.function.name}: ${(err as Error).message}`,
            });
          }
      return { ok: true, summary };
    } catch (err) {
      // Roll back any partial state so reloadFromConfig can retry; leaving a
      // half-bridged record around silently blocks future reload diffs.
      const reason = (err as Error).message;
      const provisional = records.get(raw);
      if (provisional) {
        for (const dispose of provisional.notificationDisposers) dispose();
        const liveTools = ctx.getTools();
        for (const registered of provisional.registeredNames) {
          liveTools?.unregister(registered);
          loop?.prefix.removeTool(registered);
        }
        records.delete(raw);
        const idx = insertionOrder.indexOf(raw);
        if (idx >= 0) insertionOrder.splice(idx, 1);
      }
      await mcp?.close().catch(() => undefined);
      if (!provisional) {
        rejectReady(new Error(`MCP server "${label}" failed to start: ${reason}`));
      }
      sink({ kind: "failed", name: label, reason });
      failureMap.set(raw, { spec: raw, name: label, reason, at: Date.now() });
      return { ok: false, reason };
    }
  }

  async function removeSpecImpl(raw: string, loop?: CacheFirstLoop): Promise<boolean> {
    failureMap.delete(raw);
    const record = records.get(raw);
    if (!record) return false;
    for (const dispose of record.notificationDisposers) dispose();
    await record.client.close().catch(() => undefined);
    const tools = ctx.getTools();
    for (const name of record.registeredNames) {
      tools?.unregister(name);
      loop?.prefix.removeTool(name);
    }
    records.delete(raw);
    const idx = insertionOrder.indexOf(raw);
    if (idx >= 0) insertionOrder.splice(idx, 1);
    return true;
  }

  async function reloadFromConfigImpl(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }> {
    ensureWatcher(loop);
    const normalized = normalizeMcpConfig(readMergedConfig());
    const desired = normalized.map(specToRaw);
    const desiredSet = new Set(desired);
    const currentSet = new Set(records.keys());
    const added: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ spec: string; reason: string }> = [];

    for (const spec of [...currentSet]) {
      if (!desiredSet.has(spec)) {
        await removeSpecImpl(spec, loop);
        removed.push(spec);
      }
    }
    for (const spec of desired) {
      if (currentSet.has(spec)) continue;
      const result = await addSpecImpl(spec, loop);
      if (result.ok) added.push(spec);
      else failed.push({ spec, reason: result.reason });
    }
    return { added, removed, failed, summaries: summaries() };
  }

  function addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }> {
    return enqueueMutation(
      `addSpec:${raw}`,
      raw,
      () => addSpecImpl(raw, loop, signal),
      (err) => ({
        ok: false as const,
        reason: (err as Error).message,
      }),
    );
  }

  function removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean> {
    return enqueueMutation(
      `removeSpec:${raw}`,
      raw,
      () => removeSpecImpl(raw, loop),
      () => false,
    );
  }

  function reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }> {
    return enqueueMutation(
      "reloadFromConfig",
      "mcp",
      () => reloadFromConfigImpl(loop),
      (err) => ({
        added: [],
        removed: [],
        failed: [{ spec: "config", reason: (err as Error).message }],
        summaries: summaries(),
      }),
    );
  }

  function refilter(loop?: CacheFirstLoop): Promise<{ added: string[]; removed: string[] }> {
    return enqueueMutation(
      "refilter",
      "mcp",
      () => refilterImpl(loop),
      () => ({
        added: [],
        removed: [],
      }),
    );
  }

  async function refilterImpl(
    loop?: CacheFirstLoop,
  ): Promise<{ added: string[]; removed: string[] }> {
    const added: string[] = [];
    const removed: string[] = [];
    const selection = ctx.getToolSelection?.() ?? null;
    const tools = ctx.getTools();
    if (!tools) return { added, removed };
    for (const record of records.values()) {
      for (const name of [...record.registeredNames]) {
        if (isToolSelected(name, selection)) continue;
        tools.unregister(name);
        loop?.prefix.removeTool(name);
        record.registeredNames = record.registeredNames.filter((n) => n !== name);
        record.registeredSpecs = record.registeredSpecs.filter((s) => s.function.name !== name);
        removed.push(name);
      }
      for (const mcpTool of record.mcpTools) {
        const registeredName = `${record.bridgeEnv.prefix}${mcpTool.name}`;
        if (record.registeredNames.includes(registeredName)) continue;
        if (!isToolSelected(registeredName, selection)) continue;
        const addedName = registerMcpTool(record, mcpTool, loop);
        if (addedName) added.push(addedName);
      }
    }
    if (added.length > 0 || removed.length > 0) {
      sink({
        kind: "warn",
        name: "mcp",
        reason: "selection 调整，下一 turn cache miss",
      });
    }
    return { added, removed };
  }

  async function handleToolsListChanged(
    raw: string,
    label: string,
    loop?: CacheFirstLoop,
  ): Promise<void> {
    const record = records.get(raw);
    if (!record) return;
    const listed = await record.host.client.listTools();
    const drift = classifyToolListDrift(toToolSpecs(record.mcpTools), toToolSpecs(listed.tools));
    if (drift.kind === "identity") {
      record.mcpTools = listed.tools;
      return;
    }
    if (drift.kind !== "append") {
      sink({
        kind: "warn",
        name: label,
        reason: `tools/list_changed ${drift.kind}; restart or /mcp reconnect to apply safely`,
      });
      return;
    }
    const addedNames: string[] = [];
    for (const tool of listed.tools.filter((t) => drift.added.includes(t.name))) {
      const name = registerMcpTool(record, tool, loop);
      if (name) addedNames.push(name);
    }
    record.mcpTools = listed.tools;
    if (addedNames.length > 0) {
      sink({
        kind: "warn",
        name: label,
        reason: `工具增 ${addedNames.length} 项，下一 turn cache miss`,
      });
    }
  }

  async function handleUnhealthy(raw: string, label: string, loop?: CacheFirstLoop): Promise<void> {
    if (permanentlyFailed.has(raw)) return;
    const now = Date.now();
    if (now - (lastReconnectAt.get(raw) ?? 0) < 60_000) return;
    const record = records.get(raw);
    if (!record) return;
    lastReconnectAt.set(raw, now);
    const result = await reconnectMcpServer({
      host: record.host,
      spec: raw,
      beforeTools: record.mcpTools,
      env: record.env,
      headers: record.headers,
      accept: ["identity", "append"],
    });
    if (result.ok) {
      reconnectFailures.delete(raw);
      record.client = record.host.client;
      record.mcpTools = result.afterTools;
      record.bridgeEnv.tracker?.markRecovered();
      for (const dispose of record.notificationDisposers) dispose();
      record.notificationDisposers = bindNotificationHandlers(raw, label, record.host.client, loop);
      for (const tool of result.addedTools) registerMcpTool(record, tool, loop);
      sink({
        kind: "warn",
        name: label,
        reason: `self-heal reconnect ok (${result.kind})`,
      });
      return;
    }
    const failures = (reconnectFailures.get(raw) ?? 0) + 1;
    reconnectFailures.set(raw, failures);
    sink({ kind: "failed", name: label, reason: result.message });
    if (failures >= 3) {
      permanentlyFailed.add(raw);
      sink({ kind: "permanently_failed", name: label, reason: result.message });
    }
  }

  function registerMcpTool(
    record: SpecRecord,
    mcpTool: McpTool,
    loop?: CacheFirstLoop,
  ): string | null {
    const tools = ctx.getTools();
    if (!tools) return null;
    const registeredName = registerSingleMcpTool(mcpTool, record.bridgeEnv);
    if (!registeredName) return null;
    const selection = ctx.getToolSelection?.() ?? null;
    if (!isToolSelected(registeredName, selection)) {
      tools.unregister(registeredName);
      return null;
    }
    const spec = tools.specs().find((s) => s.function.name === registeredName);
    if (!spec) return null;
    record.registeredNames.push(registeredName);
    record.registeredSpecs.push(spec);
    try {
      loop?.prefix.addTool(spec);
    } catch (err) {
      sink({
        kind: "warn",
        name: record.summary.label,
        reason: `addTool failed for ${registeredName}: ${(err as Error).message}`,
      });
    }
    return registeredName;
  }

  function bindNotificationHandlers(
    raw: string,
    label: string,
    client: McpClient,
    loop?: CacheFirstLoop,
  ): Array<() => void> {
    return [
      client.onToolsListChanged(() =>
        enqueueMutation(`tools/list_changed:${raw}`, label, () =>
          handleToolsListChanged(raw, label, loop),
        ),
      ),
      client.onResourcesListChanged(() => {
        sink({
          kind: "warn",
          name: label,
          reason: "resources/list_changed received",
        });
      }),
      client.onPromptsListChanged(() => {
        sink({
          kind: "warn",
          name: label,
          reason: "prompts/list_changed received",
        });
      }),
    ];
  }

  function enqueueMutation<T>(
    _id: string,
    name: string,
    work: () => Promise<T>,
    onError?: (err: unknown) => T,
  ): Promise<T> {
    const run = _queue.then(
      () => work(),
      () => work(),
    );
    _queue = run.then(
      () => undefined,
      (err) => {
        sink({ kind: "warn", name, reason: (err as Error).message });
      },
    );
    return onError ? run.catch(onError) : run;
  }

  function ensureWatcher(loop?: CacheFirstLoop): void {
    if (!loop || mcpWatcher) return;
    try {
      mcpWatcher = fs.watch(join(ctx.projectRoot(), ".mcp.json"), () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          void reloadFromConfig(loop);
        }, 500);
      });
    } catch {
      mcpWatcher = null;
    }
  }

  function readMergedConfig(): ReturnType<typeof readConfig> {
    const cfg = readConfig();
    const project = loadDotMcpJson(ctx.projectRoot());
    if (!project) return cfg;
    return { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), ...project } };
  }

  function specs(): string[] {
    return [...insertionOrder];
  }
  function summaries(): McpServerSummary[] {
    return insertionOrder
      .map((s) => records.get(s)?.summary)
      .filter((s): s is McpServerSummary => Boolean(s));
  }
  async function closeAll(): Promise<void> {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    mcpWatcher?.close();
    mcpWatcher = null;
    for (const r of records.values()) {
      for (const dispose of r.notificationDisposers) dispose();
      await r.client.close().catch(() => undefined);
    }
    records.clear();
    insertionOrder.length = 0;
    failureMap.clear();
    lastReconnectAt.clear();
    reconnectFailures.clear();
    permanentlyFailed.clear();
  }
  function failures(): McpFailure[] {
    return [...failureMap.values()];
  }
  function setLifecycleSink(s: McpLifecycleSink): void {
    sink = s;
  }
  return {
    size: () => records.size,
    specs,
    summaries,
    failures,
    addSpec,
    removeSpec,
    reloadFromConfig,
    refilter,
    closeAll,
    setLifecycleSink,
  };
}

function toToolSpecs(tools: readonly McpTool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema as ToolSpec["function"]["parameters"],
    },
  }));
}

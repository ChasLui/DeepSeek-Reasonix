/** Daemon session host — owns CacheFirstLoop sessions over a local socket, generalizing the ACP stdio host to many client connections. */

import { dispatchKernelEvent } from "../acp/dispatch.js";
import { requestPermissionForGate } from "../acp/gates.js";
import {
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  ERR_INVALID_PARAMS,
  type InitializeParams,
  type InitializeResult,
  type SessionCancelParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type StopReason,
  flattenPrompt,
} from "../acp/protocol.js";
import type { AcpServer } from "../acp/server.js";
import { type Session, buildSession, resolveDir } from "../cli/commands/acp.js";
import { type EditMode, loadEditMode } from "../config.js";
import { PauseGate, type PauseRequest, pauseGate } from "../core/pause-gate.js";
import { autoResolveVerdict } from "../core/pause-policy.js";
import { appendUsage } from "../telemetry/usage.js";
import { VERSION } from "../version.js";
import { IndexMaintainer } from "./index-maintainer.js";
import { McpPool } from "./mcp-pool.js";
import { WorkspaceLifecycle } from "./workspace-lifecycle.js";

/** Per-workspace idle window before `WorkspaceLifecycle` emits `idle` (background prebuild trigger, Slice 2). 0 disables. */
function resolveWorkspaceQuietMs(): number {
  const raw = process.env.REASONIX_WORKSPACE_QUIET_MS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface DaemonHostOptions {
  defaultDir: string;
  model?: string;
  budgetUsd?: number;
  mcpSpecs?: string[];
  mcpPrefix?: string;
  yolo?: boolean;
  /** Override session construction — the seam Slice 3's per-workspace pool plugs into; tests inject a loop stub. */
  createSession?: (rootDir: string) => Promise<Session>;
  /** Shut down after this many ms with zero sessions. 0/undefined disables (stay up forever). */
  idleMs?: number;
  /** Fired when the idle window elapses with no sessions — the run command triggers graceful shutdown. */
  onIdle?: () => void;
  /** Enable Pillar 5 background index maintenance (per-workspace fs-watch → incremental). Off by default until cross-platform watch lands (Slice 3). */
  backgroundIndex?: boolean;
}

/** Per-session loop snapshot the rich (desktop) client reads for its display panels. */
export interface DaemonSessionStats {
  budgetUsd: number | null;
  logTokens: number;
  prefixSystem: string;
  prefixToolSpecs: string;
}

/** Daemon-side bookkeeping the ACP `Session` doesn't carry: owning connection + per-session HITL gate. */
interface SessionMeta {
  owner: AcpServer;
  /** Per-session PauseGate — its identity IS the session binding, so confirmations route to `owner` with no AsyncLocalStorage attribution (Slice 4). Absent for injected (test stub) sessions. */
  gate?: PauseGate;
}

/** Register the routing listener for one session's gate: auto-resolve by policy, else round-trip a permission request to the owning connection. Resolves on the same gate, so per-session ids never collide. */
export function attachSessionGate(
  gate: PauseGate,
  server: AcpServer,
  sessionId: string,
  editMode: EditMode,
): void {
  gate.on((req: PauseRequest) => {
    const auto = autoResolveVerdict(req, editMode);
    if (auto !== null) {
      gate.resolve(req.id, auto);
      return;
    }
    void requestPermissionForGate(server, sessionId, req).then((verdict) =>
      gate.resolve(req.id, verdict),
    );
  });
}

export class DaemonHost {
  private readonly sessions = new Map<string, Session>();
  private readonly meta = new Map<string, SessionMeta>();
  // Warm MCP children shared across sessions in the same workspace (FR-005).
  private readonly mcpPool = new McpPool();
  // Per-workspace session/RPC bookkeeping — background indexing subscribes to its
  // closed/idle events to start/stop watchers and trigger idle prebuild (Slice 1+).
  private readonly lifecycle = new WorkspaceLifecycle(resolveWorkspaceQuietMs());
  // Pillar 5 background index maintenance, subscribed to `lifecycle`. Null unless enabled.
  private readonly indexMaintainer: IndexMaintainer | null;
  private gateUnsub: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: DaemonHostOptions) {
    this.indexMaintainer = opts.backgroundIndex ? new IndexMaintainer(this.lifecycle) : null;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Per-workspace lifecycle events (closed/idle) for background index maintenance. */
  get workspaceLifecycle(): WorkspaceLifecycle {
    return this.lifecycle;
  }

  /** Per-workspace background index maintenance status (empty when disabled). */
  indexStatus(): Array<{
    root: string;
    pendingStale: number;
    lastHeavyMs: number | null;
  }> {
    return this.indexMaintainer?.status() ?? [];
  }

  /** Read-only snapshot for the status endpoint — no loop internals leak. */
  sessionSummaries(): Array<{ id: string; workspace: string; busy: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      workspace: s.rootDir,
      busy: s.aborter !== null,
    }));
  }

  private editMode(): EditMode {
    return this.opts.yolo ? "yolo" : loadEditMode();
  }

  /** Arm idle-shutdown iff configured and no sessions remain (Slice 5). */
  private armIdle(): void {
    if (!this.opts.idleMs || this.sessions.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.sessions.size === 0) this.opts.onIdle?.();
    }, this.opts.idleMs);
    this.idleTimer.unref?.();
  }

  private disarmIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async createSession(
    rootDir: string,
    server: AcpServer,
  ): Promise<{ session: Session; gate?: PauseGate }> {
    if (this.opts.createSession) return { session: await this.opts.createSession(rootDir) };
    const specs = this.opts.mcpSpecs ?? [];
    const gate = new PauseGate();
    const session = await buildSession({
      rootDir,
      modelOverride: this.opts.model,
      budgetUsd: this.opts.budgetUsd,
      mcpSpecs: specs,
      mcpPrefix: this.opts.mcpPrefix,
      // The session's own gate routes confirmations to its owning connection.
      confirmationGate: gate,
      // Bridge the workspace's warm pool into this session's own registry; the
      // pool owns the children, so the session's mcpClients stays empty and
      // detach()/closeAll() never tear shared children down per-session.
      bridgeMcp: async (tools) => {
        await this.mcpPool.bridgeInto(rootDir, specs, this.opts.mcpPrefix, tools);
        return [];
      },
    });
    attachSessionGate(gate, server, session.id, this.editMode());
    return { session, gate };
  }

  /** Register a fail-closed fallback on the GLOBAL gate for confirmations raised outside a session's own gate — e.g. subagents, which construct child loops on the default singleton. Idempotent. */
  start(): void {
    if (this.gateUnsub) return;
    const editMode = this.editMode();
    this.gateUnsub = pauseGate.on((req) => {
      const auto = autoResolveVerdict(req, editMode);
      if (auto !== null) pauseGate.resolve(req.id, auto);
      else pauseGate.cancel(req.id);
    });
    // A daemon that boots and is never connected to should still idle out.
    this.armIdle();
  }

  /** Wire the JSON-RPC method handlers onto one client connection. */
  attach(server: AcpServer): void {
    server.onRequest<InitializeParams, InitializeResult>("initialize", (params) => {
      if (!params || typeof params !== "object") {
        throw Object.assign(new Error("initialize: missing params"), {
          code: ERR_INVALID_PARAMS,
        });
      }
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: true,
          },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: "reasonix", title: "Reasonix", version: VERSION },
        authMethods: [],
      };
    });

    server.onRequest("ping", () => ({
      ok: true,
      pid: process.pid,
      version: VERSION,
      sessions: this.sessions.size,
    }));

    server.onRequest<SessionNewParams, SessionNewResult>("session/new", async (params) => {
      const rootDir = resolveDir(params?.cwd, this.opts.defaultDir);
      const { session, gate } = await this.createSession(rootDir, server);
      this.sessions.set(session.id, session);
      this.meta.set(session.id, { owner: server, gate });
      this.disarmIdle();
      this.lifecycle.onSessionOpen(rootDir);
      return { sessionId: session.id };
    });

    server.onRequest<SessionPromptParams, SessionPromptResult>("session/prompt", async (params) => {
      const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
      if (!params?.sessionId || !session) {
        throw Object.assign(new Error(`session/prompt: unknown session ${params?.sessionId}`), {
          code: ERR_INVALID_PARAMS,
        });
      }
      // INV-2: at most one in-flight turn per session (append-only log integrity).
      if (session.aborter) {
        throw Object.assign(new Error("session/prompt: session is busy"), {
          code: ERR_INVALID_PARAMS,
        });
      }
      const text = flattenPrompt(params.prompt as ContentBlock[]);
      if (!text) {
        throw Object.assign(new Error("session/prompt: empty prompt"), {
          code: ERR_INVALID_PARAMS,
        });
      }
      const aborter = new AbortController();
      session.aborter = aborter;
      this.lifecycle.onRpcStart(session.rootDir);
      let stopReason: StopReason = "end_turn";
      try {
        for await (const ev of session.loop.step(text)) {
          if (aborter.signal.aborted) {
            stopReason = "cancelled";
            break;
          }
          // Two streams: raw LoopEvent reuses run.ts's headless renderer verbatim;
          // the kernel-event session/update stream is what rich (TUI / desktop)
          // clients already know how to render (same shape ACP emits).
          server.sendNotification("session/loopEvent", {
            sessionId: session.id,
            event: ev,
          });
          if (session.eventizer) {
            for (const kev of session.eventizer.consume(ev, session.ctx)) {
              dispatchKernelEvent(server, session.id, kev);
            }
          }
          if (ev.role === "error") stopReason = "error";
          if (ev.role === "assistant_final" && ev.stats?.usage) {
            appendUsage({
              session: null,
              model: ev.stats.model,
              usage: ev.stats.usage,
              workspace: session.rootDir,
            });
          }
        }
      } catch (err) {
        server.sendNotification("session/loopEvent", {
          sessionId: session.id,
          event: {
            turn: 0,
            role: "error",
            content: "",
            error: (err as Error).message,
          },
        });
        stopReason = "error";
      } finally {
        session.aborter = null;
        this.lifecycle.onRpcEnd(session.rootDir);
      }
      return { stopReason };
    });

    server.onNotification<SessionCancelParams>("session/cancel", (params) => {
      const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
      session?.aborter?.abort();
      // Free any tool stranded awaiting a confirmation on this session's gate.
      this.meta.get(params?.sessionId ?? "")?.gate?.cancelAll();
    });

    // Loop control + read RPCs the rich (desktop) thin client drives over the wire (Slice 5).
    const sessionOf = (p: { sessionId?: string } | undefined): Session => {
      const s = p?.sessionId ? this.sessions.get(p.sessionId) : undefined;
      if (!s) {
        throw Object.assign(new Error(`unknown session ${p?.sessionId}`), {
          code: ERR_INVALID_PARAMS,
        });
      }
      return s;
    };
    server.onRequest<
      { sessionId: string; reasoningEffort?: "high" | "max"; model?: string },
      { ok: true }
    >("session/configure", (params) => {
      const cfg: { reasoningEffort?: "high" | "max"; model?: string } = {};
      if (params?.reasoningEffort) cfg.reasoningEffort = params.reasoningEffort;
      if (params?.model) cfg.model = params.model;
      sessionOf(params).loop.configure(cfg);
      return { ok: true };
    });
    server.onRequest<{ sessionId: string; usd: number | null }, { ok: true }>(
      "session/setBudget",
      (params) => {
        sessionOf(params).loop.setBudget(params?.usd ?? null);
        return { ok: true };
      },
    );
    server.onRequest<{ sessionId: string }, DaemonSessionStats>("session/stats", (params) => {
      const loop = sessionOf(params).loop;
      return {
        budgetUsd: loop.budgetUsd,
        logTokens: loop.getCurrentLogTokens(),
        prefixSystem: loop.prefix.system,
        prefixToolSpecs: JSON.stringify(loop.prefix.toolSpecs),
      };
    });
    server.onRequest<{ sessionId: string }, { text: string | null }>("session/retry", (params) => ({
      text: sessionOf(params).loop.retryLastUser(),
    }));
    server.onRequest<{ sessionId: string }, { ok: true }>("session/compact", async (params) => {
      const s = sessionOf(params);
      this.lifecycle.onRpcStart(s.rootDir);
      try {
        await s.loop.compactHistory();
        return { ok: true };
      } finally {
        this.lifecycle.onRpcEnd(s.rootDir);
      }
    });
    server.onRequest<
      {
        sessionId: string;
        model: string;
        messages: Array<{ role: string; content: string }>;
      },
      { content: string }
    >("session/chat", async (params) => {
      const s = sessionOf(params);
      this.lifecycle.onRpcStart(s.rootDir);
      try {
        const reply = await s.loop.client.chat({
          model: params.model,
          messages: params.messages as never,
        });
        return { content: reply.content ?? "" };
      } finally {
        this.lifecycle.onRpcEnd(s.rootDir);
      }
    });
    server.onRequest<{ sessionId: string }, { balance: unknown } | null>(
      "session/balance",
      async (params) => {
        const s = sessionOf(params);
        this.lifecycle.onRpcStart(s.rootDir);
        try {
          const bal = await s.loop.client.getBalance().catch(() => null);
          return bal ? { balance: bal } : null;
        } finally {
          this.lifecycle.onRpcEnd(s.rootDir);
        }
      },
    );
  }

  /** Drop every session owned by a disconnected connection, freeing stranded gates + tearing down per-session MCP children. */
  async detach(server: AcpServer): Promise<void> {
    const closes: Promise<unknown>[] = [];
    for (const [sid, meta] of this.meta) {
      if (meta.owner !== server) continue;
      const session = this.sessions.get(sid);
      meta.gate?.cancelAll();
      session?.aborter?.abort();
      if (session) {
        for (const mcp of session.mcpClients) closes.push(mcp.close().catch(() => undefined));
      }
      this.sessions.delete(sid);
      this.meta.delete(sid);
      // Per-workspace refcount-- happens ONLY on detach (true session removal),
      // never on session/cancel which keeps the session alive (B2).
      if (session) this.lifecycle.onSessionClose(session.rootDir);
    }
    // Last session for this connection gone → start the idle countdown.
    this.armIdle();
    await Promise.all(closes);
  }

  async closeAll(): Promise<void> {
    this.disarmIdle();
    const closes: Promise<unknown>[] = [];
    for (const meta of this.meta.values()) meta.gate?.cancelAll();
    for (const session of this.sessions.values()) {
      session.aborter?.abort();
      for (const mcp of session.mcpClients) closes.push(mcp.close().catch(() => undefined));
    }
    this.sessions.clear();
    this.meta.clear();
    this.lifecycle.dispose();
    this.indexMaintainer?.dispose();
    if (this.gateUnsub) {
      this.gateUnsub();
      this.gateUnsub = null;
    }
    closes.push(this.mcpPool.closeAll());
    await Promise.all(closes);
  }
}

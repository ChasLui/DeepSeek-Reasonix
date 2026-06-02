/** Daemon session host — owns CacheFirstLoop sessions over a local socket, generalizing the ACP stdio host to many client connections. */

import { AsyncLocalStorage } from "node:async_hooks";
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
import type { PauseRequest } from "../core/pause-gate.js";
import { pauseGate } from "../core/pause-gate.js";
import { autoResolveVerdict } from "../core/pause-policy.js";
import { appendUsage } from "../telemetry/usage.js";
import { VERSION } from "../version.js";
import { McpPool } from "./mcp-pool.js";

export interface DaemonHostOptions {
  defaultDir: string;
  model?: string;
  budgetUsd?: number;
  mcpSpecs?: string[];
  mcpPrefix?: string;
  yolo?: boolean;
  /** Override session construction — the seam Slice 3's per-workspace pool plugs into; tests inject a loop stub. */
  createSession?: (rootDir: string) => Promise<Session>;
}

/** Daemon-side bookkeeping the ACP `Session` doesn't carry: which connection owns it and its auto-resolve policy. */
interface SessionMeta {
  owner: AcpServer;
  editMode: EditMode;
}

export class DaemonHost {
  private readonly sessions = new Map<string, Session>();
  private readonly meta = new Map<string, SessionMeta>();
  private readonly sessionContext = new AsyncLocalStorage<string>();
  // Warm MCP children shared across sessions in the same workspace (FR-005).
  private readonly mcpPool = new McpPool();
  private gateUnsub: (() => void) | null = null;

  constructor(private readonly opts: DaemonHostOptions) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  private createSession(rootDir: string): Promise<Session> {
    if (this.opts.createSession) return this.opts.createSession(rootDir);
    const specs = this.opts.mcpSpecs ?? [];
    return buildSession({
      rootDir,
      modelOverride: this.opts.model,
      budgetUsd: this.opts.budgetUsd,
      mcpSpecs: specs,
      mcpPrefix: this.opts.mcpPrefix,
      // Bridge the workspace's warm pool into this session's own registry; the
      // pool owns the children, so the session's mcpClients stays empty and
      // detach()/closeAll() never tear shared children down per-session.
      bridgeMcp: async (tools) => {
        await this.mcpPool.bridgeInto(rootDir, specs, this.opts.mcpPrefix, tools);
        return [];
      },
    });
  }

  /** Register the single process-wide gate listener. Idempotent. */
  start(): void {
    if (this.gateUnsub) return;
    this.gateUnsub = pauseGate.on((req) => this.routeGate(req));
  }

  private routeGate(req: PauseRequest): void {
    // Source of truth for attribution is the ALS scope the loop step runs in.
    // Fail closed: no/unknown session → cancel (safe deny verdict).
    const sid = this.sessionContext.getStore();
    const meta = sid ? this.meta.get(sid) : undefined;
    if (!sid || !meta || !this.sessions.has(sid)) {
      pauseGate.cancel(req.id);
      return;
    }
    const auto = autoResolveVerdict(req, meta.editMode);
    if (auto !== null) {
      pauseGate.resolve(req.id, auto);
      return;
    }
    void (async () => {
      const verdict = await requestPermissionForGate(meta.owner, sid, req);
      pauseGate.resolve(req.id, verdict);
    })();
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
      const session = await this.createSession(rootDir);
      this.sessions.set(session.id, session);
      this.meta.set(session.id, {
        owner: server,
        editMode: this.opts.yolo ? "yolo" : loadEditMode(),
      });
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
      let stopReason: StopReason = "end_turn";
      try {
        await this.sessionContext.run(session.id, async () => {
          for await (const ev of session.loop.step(text)) {
            if (aborter.signal.aborted) {
              stopReason = "cancelled";
              break;
            }
            // Carries the raw LoopEvent so the headless client reuses run.ts's
            // renderer verbatim; richer (TUI) clients converge on kernel events in Slice 4.
            server.sendNotification("session/loopEvent", {
              sessionId: session.id,
              event: ev,
            });
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
        });
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
      }
      return { stopReason };
    });

    server.onNotification<SessionCancelParams>("session/cancel", (params) => {
      const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
      session?.aborter?.abort();
    });
  }

  /** Drop every session owned by a disconnected connection, tearing down its MCP children. */
  async detach(server: AcpServer): Promise<void> {
    const closes: Promise<unknown>[] = [];
    for (const [sid, meta] of this.meta) {
      if (meta.owner !== server) continue;
      const session = this.sessions.get(sid);
      session?.aborter?.abort();
      if (session) {
        for (const mcp of session.mcpClients) closes.push(mcp.close().catch(() => undefined));
      }
      this.sessions.delete(sid);
      this.meta.delete(sid);
    }
    await Promise.all(closes);
  }

  async closeAll(): Promise<void> {
    const closes: Promise<unknown>[] = [];
    for (const session of this.sessions.values()) {
      session.aborter?.abort();
      for (const mcp of session.mcpClients) closes.push(mcp.close().catch(() => undefined));
    }
    this.sessions.clear();
    this.meta.clear();
    if (this.gateUnsub) {
      this.gateUnsub();
      this.gateUnsub = null;
    }
    closes.push(this.mcpPool.closeAll());
    await Promise.all(closes);
  }
}

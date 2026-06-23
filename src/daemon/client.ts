/** Daemon client — connects to the control socket and drives a remote session over NDJSON JSON-RPC. */

import { type Socket, createConnection } from "node:net";
import type {
  PermissionRequestParams,
  PermissionRequestResult,
  SessionUpdateParams,
} from "../acp/protocol.js";
import { AcpServer } from "../acp/server.js";
import type { LoopEvent } from "../loop/types.js";
import type { DaemonSessionStats } from "./host.js";

export interface DaemonClientOptions {
  /** Handle a daemon-forwarded confirmation. Omit → fail closed (cancelled/deny). */
  onPermission?:
    | ((params: PermissionRequestParams) => Promise<PermissionRequestResult>)
    | undefined;
  /** Subscribe to the kernel-event session/update stream (what a rich/TUI client renders). */
  onUpdate?: ((params: SessionUpdateParams) => void) | undefined;
}

export interface DaemonClient {
  initialize(): Promise<void>;
  newSession(cwd: string): Promise<string>;
  prompt(sessionId: string, text: string, onEvent: (ev: LoopEvent) => void): Promise<string>;
  ping(): Promise<{ pid: number; version: string; sessions: number }>;
  // Loop control + reads the rich (desktop) client drives over the wire.
  configure(
    sessionId: string,
    opts: { reasoningEffort?: "high" | "max"; model?: string },
  ): Promise<void>;
  setBudget(sessionId: string, usd: number | null): Promise<void>;
  stats(sessionId: string): Promise<DaemonSessionStats>;
  retry(sessionId: string): Promise<string | null>;
  compact(sessionId: string): Promise<void>;
  chat(
    sessionId: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string>;
  balance(sessionId: string): Promise<unknown>;
  cancel(sessionId: string): void;
  close(): void;
}

export function connectDaemon(
  socketPath: string,
  opts: DaemonClientOptions = {},
): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      const rpc = new AcpServer({ input: socket, output: socket });
      let onLoopEvent: ((ev: LoopEvent) => void) | null = null;
      rpc.onNotification<{ sessionId: string; event: LoopEvent }>("session/loopEvent", (p) => {
        if (p?.event && onLoopEvent) onLoopEvent(p.event);
      });
      rpc.onNotification<SessionUpdateParams>("session/update", (p) => {
        if (p && opts.onUpdate) opts.onUpdate(p);
      });
      rpc.onRequest<PermissionRequestParams, PermissionRequestResult>(
        "session/request_permission",
        async (params) => {
          if (opts.onPermission) return opts.onPermission(params);
          return { outcome: { outcome: "cancelled" } };
        },
      );
      resolve({
        async initialize() {
          await rpc.sendRequest("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          });
        },
        async newSession(cwd) {
          const r = await rpc.sendRequest<{ sessionId: string }>("session/new", { cwd });
          return r.sessionId;
        },
        async prompt(sessionId, text, onEvent) {
          onLoopEvent = onEvent;
          try {
            const r = await rpc.sendRequest<{ stopReason: string }>("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            return r.stopReason;
          } finally {
            onLoopEvent = null;
          }
        },
        async ping() {
          return rpc.sendRequest("ping", {});
        },
        async configure(sessionId, configureOpts) {
          await rpc.sendRequest("session/configure", {
            sessionId,
            ...configureOpts,
          });
        },
        async setBudget(sessionId, usd) {
          await rpc.sendRequest("session/setBudget", { sessionId, usd });
        },
        async stats(sessionId) {
          return rpc.sendRequest("session/stats", { sessionId });
        },
        async retry(sessionId) {
          const r = await rpc.sendRequest<{ text: string | null }>("session/retry", { sessionId });
          return r.text;
        },
        async compact(sessionId) {
          await rpc.sendRequest("session/compact", { sessionId });
        },
        async chat(sessionId, model, messages) {
          const r = await rpc.sendRequest<{ content: string }>("session/chat", {
            sessionId,
            model,
            messages,
          });
          return r.content;
        },
        async balance(sessionId) {
          const r = await rpc.sendRequest<{ balance: unknown } | null>("session/balance", {
            sessionId,
          });
          return r?.balance ?? null;
        },
        cancel(sessionId) {
          rpc.sendNotification("session/cancel", { sessionId });
        },
        close() {
          rpc.close();
          socket.end();
        },
      });
    });
  });
}

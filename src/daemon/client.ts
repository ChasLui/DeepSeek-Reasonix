/** Daemon client — connects to the control socket and drives a remote session over NDJSON JSON-RPC. */

import { type Socket, createConnection } from "node:net";
import { AcpServer } from "../acp/server.js";
import type { LoopEvent } from "../loop/types.js";

export interface DaemonClient {
  initialize(): Promise<void>;
  newSession(cwd: string): Promise<string>;
  prompt(sessionId: string, text: string, onEvent: (ev: LoopEvent) => void): Promise<string>;
  ping(): Promise<{ pid: number; version: string; sessions: number }>;
  close(): void;
}

export function connectDaemon(socketPath: string): Promise<DaemonClient> {
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
        close() {
          rpc.close();
          socket.end();
        },
      });
    });
  });
}

/** Read-only HTTP status endpoint for the daemon — loopback-only observability (GET /health, /status). */

import { type Server, createServer } from "node:http";
import { VERSION } from "../version.js";
import type { DaemonHost } from "./host.js";

export interface DaemonStatus {
  ok: true;
  pid: number;
  version: string;
  uptimeMs: number;
  sessions: Array<{ id: string; workspace: string; busy: boolean }>;
  index: Array<{
    root: string;
    pendingStale: number;
    lastHeavyMs: number | null;
  }>;
}

export function daemonStatusPayload(
  host: DaemonHost,
  startedAtMs: number,
  nowMs: number,
): DaemonStatus {
  return {
    ok: true,
    pid: process.pid,
    version: VERSION,
    uptimeMs: Math.max(0, nowMs - startedAtMs),
    sessions: host.sessionSummaries(),
    index: host.indexStatus(),
  };
}

/** Bind a loopback-only HTTP server exposing /health and /status. Read-only, no mutations. */
export function startStatusServer(
  host: DaemonHost,
  port: number,
  startedAtMs: number,
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(daemonStatusPayload(host, startedAtMs, Date.now())));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only — the status surface is unauthenticated, so never bind a routable address.
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

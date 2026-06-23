/** Open a daemon-backed session for one desktop tab: auto-start the daemon, connect a per-tab client whose confirmations re-raise on the tab's local PauseGate (reusing the desktop's confirm UI), and wrap it in a RemoteLoop. */

import type { PauseAskOpts } from "../core/pause-gate.js";
import { daemonSocketPath } from "../storage/path.js";
import { type DaemonClient, connectDaemon } from "./client.js";
import { acpPermissionToPauseAsk, pauseVerdictToAcp } from "./confirm-bridge.js";
import { ensureDaemon } from "./ensure.js";
import { RemoteLoop } from "./remote-loop.js";

export interface DesktopDaemonSession {
  client: DaemonClient;
  sessionId: string;
  loop: RemoteLoop;
}

export interface OpenDesktopSessionOpts {
  rootDir: string;
  model: string;
  /** Re-raise a forwarded confirmation on the desktop's local gate; resolves with the chosen verdict. */
  ask: (req: PauseAskOpts) => Promise<unknown>;
  socketPath?: string | undefined;
}

/** Overall ceiling so a wedged daemon/handshake never leaves a desktop tab without `$ready`. */
const OPEN_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function openDesktopDaemonSession(
  opts: OpenDesktopSessionOpts,
): Promise<DesktopDaemonSession> {
  return withTimeout(openInner(opts), OPEN_TIMEOUT_MS, "daemon session open");
}

async function openInner(opts: OpenDesktopSessionOpts): Promise<DesktopDaemonSession> {
  const socketPath = opts.socketPath ?? daemonSocketPath();
  await ensureDaemon(socketPath);
  const client = await connectDaemon(socketPath, {
    onPermission: async (params) => {
      const askOpts = acpPermissionToPauseAsk(params);
      const verdict = await opts.ask(askOpts);
      return pauseVerdictToAcp(askOpts.kind, verdict);
    },
  });
  await client.initialize();
  const sessionId = await client.newSession(opts.rootDir);
  const stats = await client.stats(sessionId);
  const loop = new RemoteLoop(client, sessionId, opts.model, stats);
  return { client, sessionId, loop };
}

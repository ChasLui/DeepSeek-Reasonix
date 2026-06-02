/** Auto-start the daemon: the single architecture means a thin client must always find a daemon, spawning a detached one if none is running. */

import { spawn } from "node:child_process";
import { daemonSocketPath } from "../storage/path.js";
import { type DaemonClient, connectDaemon } from "./client.js";

export interface EnsureDaemonDeps {
  connect?: (socketPath: string) => Promise<DaemonClient>;
  spawnDaemon?: () => void;
  delayMs?: (ms: number) => Promise<void>;
  /** Max poll attempts after spawn (× ~200ms). */
  attempts?: number;
}

function defaultSpawn(): void {
  // Reconstruct THIS process's launch so the daemon runs under the same runtime:
  // process.execArgv carries dev loaders (e.g. tsx's --import), without which
  // `node entry.ts daemon run` would fail on a TypeScript entrypoint.
  const args = [...process.execArgv, process.argv[1] ?? "", "daemon", "run"];
  // Detached + unref so the daemon outlives this client; stdio ignored so it
  // doesn't tie up our pipes. The log goes to the daemon's own file.
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function reachable(
  connect: (s: string) => Promise<DaemonClient>,
  socketPath: string,
): Promise<boolean> {
  try {
    const client = await connect(socketPath);
    client.close();
    return true;
  } catch {
    return false;
  }
}

/** Resolve once a daemon is reachable at `socketPath`, auto-starting a detached one if needed. Throws if it never comes up. */
export async function ensureDaemon(
  socketPath: string = daemonSocketPath(),
  deps: EnsureDaemonDeps = {},
): Promise<void> {
  const connect = deps.connect ?? connectDaemon;
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawn;
  const delay = deps.delayMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 25;

  if (await reachable(connect, socketPath)) return;

  spawnDaemon();
  for (let i = 0; i < attempts; i++) {
    await delay(200);
    if (await reachable(connect, socketPath)) return;
  }
  throw new Error(`daemon did not become reachable at ${socketPath} after auto-start`);
}

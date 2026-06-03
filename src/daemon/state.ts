/** Daemon liveness state — a tiny JSON file recording the running process so `daemon status`/`start` can find it. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { daemonStatePath, reasonixDir } from "../storage/path.js";

export interface DaemonState {
  pid: number;
  socket: string;
  version: string;
  startedAt: string;
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(reasonixDir(), { recursive: true });
  const path = daemonStatePath();
  // Write a temp sibling then rename so a reader never sees a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readDaemonState(): DaemonState | null {
  try {
    const raw = readFileSync(daemonStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonState>;
    if (typeof parsed.pid !== "number" || typeof parsed.socket !== "string") return null;
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

export function removeDaemonState(): void {
  rmSync(daemonStatePath(), { force: true });
}

/** Signal 0 probes the process table without delivering a signal — true iff a process with this pid exists and is ours to signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function reasonixDbPath(): string {
  return join(homedir(), ".reasonix", "reasonix.db");
}

// 0600 the DB and its WAL/-shm siblings. The hot, not-yet-checkpointed session +
// memory bytes live in `-wal` until a checkpoint; the JSONL backend chmod-ed every
// artifact 0600, so leaving the WAL world-readable would be a privacy regression on
// shared hosts. The siblings exist once WAL mode is enabled (guarded by existsSync).
export function secureDbFile(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, 0o600);
    } catch {
      /* chmod unsupported on this platform */
    }
  }
}

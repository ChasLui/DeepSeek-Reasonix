import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function reasonixDbPath(): string {
  return join(homedir(), ".reasonix", "reasonix.db");
}

export function secureDbFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod unsupported on this platform */
  }
}

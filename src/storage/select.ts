import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StoreBackend = "jsonl" | "sqlite";

export function storeVersionPath(homeDir?: string): string {
  return join(homeDir ?? join(homedir(), ".reasonix"), ".store-version");
}

// Hard-cutover gate (FR-026): absent / unreadable / anything but "sqlite" → file
// backend. No dual-write, no per-read fallback — the file is the single switch a
// completed `migrate-store` flips. Defaulting to jsonl keeps every wired-in call
// site behavior-identical until the user migrates.
export function storeBackend(homeDir?: string): StoreBackend {
  const path = storeVersionPath(homeDir);
  if (!existsSync(path)) return "jsonl";
  try {
    return readFileSync(path, "utf8").trim() === "sqlite" ? "sqlite" : "jsonl";
  } catch {
    return "jsonl";
  }
}

export function setStoreBackend(backend: StoreBackend, homeDir?: string): void {
  writeFileSync(storeVersionPath(homeDir), backend, "utf8");
}

// SC-005 no-split-brain ratchet: SQLite is the sole backend. This greps src/
// and fails if any removed split-brain shape (file/jsonl store, gate, migrators) returns.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Files in src/ whose text matches `re`, returned as src-relative paths. */
function offenders(files: ReadonlyArray<{ path: string; text: string }>, re: RegExp): string[] {
  return files.filter((f) => re.test(f.text)).map((f) => f.path.slice(srcDir.length + 1));
}

describe("SC-005 no split-brain — SQLite is the sole backend", () => {
  const files = walk(srcDir).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
  const serverFiles = files.filter((f) => f.path.includes(`${join("src", "server")}`));

  it("no .store-version gate (storeBackend / setStoreBackend / .store-version)", () => {
    expect(offenders(files, /\bstoreBackend\s*\(/)).toEqual([]);
    expect(offenders(files, /\bsetStoreBackend\b/)).toEqual([]);
    expect(offenders(files, /\.store-version/)).toEqual([]);
  });

  it("no file MemoryStore construction", () => {
    expect(offenders(files, /new MemoryStore\(/)).toEqual([]);
  });

  it("no usage-log file bypass (usageLogPath / defaultUsageLogPath)", () => {
    expect(offenders(files, /\busageLogPath\b/)).toEqual([]);
    expect(offenders(files, /\bdefaultUsageLogPath\b/)).toEqual([]);
  });

  it("no jsonl event adapters (event-sink-jsonl / event-source-jsonl)", () => {
    expect(offenders(files, /event-sink-jsonl/)).toEqual([]);
    expect(offenders(files, /event-source-jsonl/)).toEqual([]);
  });

  it("no migrate-store references", () => {
    expect(offenders(files, /\bmigrate-store\b/)).toEqual([]);
    expect(offenders(files, /\bmigrateStore\b/)).toEqual([]);
    expect(offenders(files, /\bmigration_state\b/)).toEqual([]);
  });

  it("no file-backed session/event reads in the server layer", () => {
    expect(offenders(serverFiles, /\breadEventLogFile\b/)).toEqual([]);
    expect(offenders(serverFiles, /existsSync\(sessionPath/)).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore } from "../../src/memory/user.js";
import { resetDb } from "../../src/storage/db.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerMemoryTools } from "../../src/tools/memory.js";

// File-byte/mtime assertions dropped — there is no on-disk markdown under SQLite. The
// read-only contract is now: repeated recalls leave the stored row byte-identical.
describe("recall_memory read-only behavior", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-recall-readonly-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    resetDb();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("does not mutate the stored row after repeated reads", async () => {
    const store = openMemoryStore({ homeDir: home });
    store.write({
      name: "cache_rule",
      type: "project",
      scope: "global",
      description: "Cache rule",
      body: "Keep the prefix append-only.",
    });
    const before = store.query("global", "cache_rule");
    const registry = new ToolRegistry();
    registerMemoryTools(registry, { homeDir: home });

    for (let i = 0; i < 1000; i++) {
      const out = await registry.dispatch("recall_memory", {
        scope: "global",
        name: "cache_rule",
      });
      expect(out).toContain("Keep the prefix append-only.");
    }

    expect(store.query("global", "cache_rule")).toEqual(before);
  });
});

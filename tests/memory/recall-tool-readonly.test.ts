import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/user.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerMemoryTools } from "../../src/tools/memory.js";

describe("recall_memory read-only behavior", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-recall-readonly-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not mutate markdown bytes or mtime after repeated reads", async () => {
    const store = new MemoryStore({ homeDir: home });
    const file = store.write({
      name: "cache_rule",
      type: "project",
      scope: "global",
      description: "Cache rule",
      body: "Keep the prefix append-only.",
    });
    const beforeBytes = readFileSync(file);
    const beforeMtime = statSync(file).mtimeMs;
    const registry = new ToolRegistry();
    registerMemoryTools(registry, { homeDir: home });

    for (let i = 0; i < 1000; i++) {
      const out = await registry.dispatch("recall_memory", {
        scope: "global",
        name: "cache_rule",
      });
      expect(out).toContain("Keep the prefix append-only.");
    }

    expect(readFileSync(file).equals(beforeBytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });
});

/** End-to-end: register the shell tools and verify run_command's output goes through compact + tee. */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDefaultsRegistered } from "../../src/compact/defaults.js";
import { resetCompactors } from "../../src/compact/registry.js";
import { resetTeeCache } from "../../src/compact/tee.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerShellTools } from "../../src/tools/shell.js";

let workspace: string;
let teeDir: string;
const origEnv = { ...process.env };

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(os.tmpdir(), "reasonix-compact-e2e-"));
  teeDir = await fs.mkdtemp(join(os.tmpdir(), "reasonix-tee-e2e-"));
  process.env.REASONIX_TEE = teeDir;
  resetTeeCache();
  resetCompactors();
  _resetDefaultsRegistered();
});

afterEach(async () => {
  process.env = { ...origEnv };
  resetTeeCache();
  resetCompactors();
  _resetDefaultsRegistered();
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(teeDir, { recursive: true, force: true });
});

async function dispatch(reg: ToolRegistry, name: string, args: unknown): Promise<string> {
  const result = await reg.dispatch(name, JSON.stringify(args));
  return typeof result === "string" ? result : JSON.stringify(result);
}

describe("run_command end-to-end compaction", () => {
  it("compacts ls output for large directories and tees the raw", async () => {
    // Populate a directory big enough to trigger the listing filter (50+ entries).
    for (let i = 0; i < 60; i++) {
      const ext = i % 2 === 0 ? "ts" : "md";
      await fs.writeFile(join(workspace, `file${i}.${ext}`), "x");
    }
    const reg = new ToolRegistry();
    registerShellTools(reg, { rootDir: workspace, allowAll: true });

    const out = await dispatch(reg, "run_command", { command: "ls" });
    expect(out).toMatch(/\[full: /);
    // Compact view summarizes by extension.
    expect(out).toMatch(/\.ts: 30/);
    // Tee file actually exists and contains the raw entries.
    const teePath = out.match(/\[full: (.+?)\]/)?.[1];
    expect(teePath).toBeTruthy();
    const teed = await fs.readFile(teePath!, "utf8");
    expect(teed).toContain("file0.ts");
    expect(teed).toContain("file59.md");
  });

  it("passes through short ls output unchanged (no compact, no tee)", async () => {
    await fs.writeFile(join(workspace, "a.ts"), "x");
    await fs.writeFile(join(workspace, "b.ts"), "x");
    const reg = new ToolRegistry();
    registerShellTools(reg, { rootDir: workspace, allowAll: true });
    const out = await dispatch(reg, "run_command", { command: "ls" });
    expect(out).not.toMatch(/\[full: /);
    expect(out).toContain("a.ts");
  });

  it("REASONIX_COMPACT=0 short-circuits the layer", async () => {
    for (let i = 0; i < 60; i++) {
      await fs.writeFile(join(workspace, `file${i}.ts`), "x");
    }
    process.env.REASONIX_COMPACT = "0";
    const reg = new ToolRegistry();
    registerShellTools(reg, { rootDir: workspace, allowAll: true });
    const out = await dispatch(reg, "run_command", { command: "ls" });
    // Layer is disabled → no full marker, no extension summary.
    expect(out).not.toMatch(/\[full: /);
    expect(out).not.toMatch(/files by extension/);
  });
});

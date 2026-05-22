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
  workspace = await fs.mkdtemp(join(os.tmpdir(), "reasonix-cs-"));
  teeDir = await fs.mkdtemp(join(os.tmpdir(), "reasonix-cs-tee-"));
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

async function makeLongLs() {
  for (let i = 0; i < 60; i++) {
    await fs.writeFile(join(workspace, `f${i}.ts`), "x");
  }
}

describe("compact config switch", () => {
  it("static config { enabled: false } disables the layer", async () => {
    await makeLongLs();
    const reg = new ToolRegistry();
    registerShellTools(reg, {
      rootDir: workspace,
      allowAll: true,
      compactRuntime: { enabled: false, exclude: new Set() },
    });
    const out = await dispatch(reg, "run_command", { command: "ls" });
    expect(out).not.toMatch(/\[full: /);
    expect(out).not.toMatch(/files by extension/);
  });

  it("static config exclude skips matching argv[0]", async () => {
    await makeLongLs();
    const reg = new ToolRegistry();
    registerShellTools(reg, {
      rootDir: workspace,
      allowAll: true,
      compactRuntime: { enabled: true, exclude: new Set(["ls"]) },
    });
    const out = await dispatch(reg, "run_command", { command: "ls" });
    expect(out).not.toMatch(/files by extension/);
  });

  it("REASONIX_COMPACT_EXCLUDE env CSV becomes the exclude set", async () => {
    await makeLongLs();
    process.env.REASONIX_COMPACT_EXCLUDE = "ls, tree";
    const reg = new ToolRegistry();
    registerShellTools(reg, { rootDir: workspace, allowAll: true });
    const out = await dispatch(reg, "run_command", { command: "ls" });
    expect(out).not.toMatch(/files by extension/);
  });

  it("getter form picks up env flip mid-session", async () => {
    await makeLongLs();
    let envVal = "1";
    const reg = new ToolRegistry();
    registerShellTools(reg, {
      rootDir: workspace,
      allowAll: true,
      compactRuntime: () => ({
        enabled: envVal !== "0",
        exclude: new Set(),
      }),
    });
    // First call: enabled → compact present
    const out1 = await dispatch(reg, "run_command", { command: "ls" });
    expect(out1).toMatch(/\[full: /);
    // Flip the env var, second call sees the change
    envVal = "0";
    const out2 = await dispatch(reg, "run_command", { command: "ls" });
    expect(out2).not.toMatch(/\[full: /);
  });
});

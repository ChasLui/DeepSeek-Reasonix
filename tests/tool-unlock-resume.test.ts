import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { getDb, resetDb } from "../src/storage/db.js";
import { recordUnlock } from "../src/storage/unlocked-tools-repo.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-resume-")), "reasonix.db");
}

function deferredReg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: "read_file", description: "read", fn: () => "ok" });
  for (const n of ["gh_op0", "gh_op1", "gh_op2"]) {
    r.register({
      name: n,
      description: `github ${n}`,
      tier: 2,
      fn: () => "ok",
    });
  }
  return r;
}

afterEach(() => resetDb());

describe("resume replay (Task 4.1 / FR-006 / SC-006)", () => {
  it("re-unlocks prior tools in seq order → prefix byte-identical to the live run", () => {
    const db = getDb(tmpDbPath());
    const session = "resume-sess";
    const at = "2026-05-31T00:00:00.000Z";
    // Live session had unlocked gh_op2 then gh_op0 (seq order matters).
    recordUnlock(db, session, "mcp", "gh_op2", 0, at);
    recordUnlock(db, session, "mcp", "gh_op0", 1, at);

    const tools = deferredReg();
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER), // [read_file] only
    });
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    // Constructing the loop with this session triggers replayUnlocks().
    new CacheFirstLoop({ client, prefix, tools, session, stream: false });

    const names = prefix.toolSpecs.map((t) => t.function?.name);
    // read_file (prefix-resident) + replayed gh_op2, gh_op0 in seq order
    expect(names).toEqual(["read_file", "gh_op2", "gh_op0"]);

    // SC-006: a reference prefix unlocked in the same order has the same fingerprint
    const ref = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
    });
    ref.addTool(tools.specOf("gh_op2")!);
    ref.addTool(tools.specOf("gh_op0")!);
    expect(prefix.fingerprint).toBe(ref.fingerprint);
  });

  it("old session with no unlock rows → zero unlocks (migration-safe)", () => {
    getDb(tmpDbPath());
    const tools = deferredReg();
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
    });
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    new CacheFirstLoop({
      client,
      prefix,
      tools,
      session: "never-unlocked",
      stream: false,
    });
    expect(prefix.toolSpecs.map((t) => t.function?.name)).toEqual(["read_file"]);
  });

  it("a persisted tool no longer registered is skipped (reconnect re-adds it later)", () => {
    const db = getDb(tmpDbPath());
    const session = "stale-sess";
    recordUnlock(db, session, "mcp", "gh_op0", 0, "2026-05-31T00:00:00.000Z");
    recordUnlock(db, session, "mcp", "gone_tool", 1, "2026-05-31T00:00:00.000Z");

    const tools = deferredReg(); // gone_tool is NOT registered
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
    });
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    new CacheFirstLoop({ client, prefix, tools, session, stream: false });

    const names = prefix.toolSpecs.map((t) => t.function?.name);
    expect(names).toEqual(["read_file", "gh_op0"]); // gone_tool skipped, no throw
  });
});

describe("reconcilePrefixTool (Task 4.2 / FR-012 reconnect alignment)", () => {
  it("Tier 0/1 always re-added; deferred-but-never-unlocked stays out", () => {
    getDb(tmpDbPath());
    const tools = deferredReg();
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
    });
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    const loop = new CacheFirstLoop({ client, prefix, tools, stream: false });

    tools.register({ name: "new_builtin", description: "x", fn: () => "ok" });
    expect(loop.reconcilePrefixTool(tools.specOf("new_builtin")!)).toBe(true);
    // tier-2, not unlocked → refused
    expect(loop.reconcilePrefixTool(tools.specOf("gh_op0")!)).toBe(false);
    expect(prefix.toolSpecs.some((t) => t.function?.name === "gh_op0")).toBe(false);
  });

  it("re-adds a previously-unlocked deferred tool after a disconnect drop", () => {
    const db = getDb(tmpDbPath());
    const session = "reconn";
    recordUnlock(db, session, "mcp", "gh_op1", 0, "2026-05-31T00:00:00.000Z");
    const tools = deferredReg();
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
    });
    const client = new DeepSeekClient({ apiKey: "sk-test" });
    const loop = new CacheFirstLoop({
      client,
      prefix,
      tools,
      session,
      stream: false,
    });
    // replay re-unlocked gh_op1; simulate the server disconnecting (removeTool)
    expect(prefix.toolSpecs.some((t) => t.function?.name === "gh_op1")).toBe(true);
    prefix.removeTool("gh_op1");
    // reconnect re-bridges → reconcile re-adds because it's in the unlock set
    expect(loop.reconcilePrefixTool(tools.specOf("gh_op1")!)).toBe(true);
    expect(prefix.toolSpecs.some((t) => t.function?.name === "gh_op1")).toBe(true);
  });
});

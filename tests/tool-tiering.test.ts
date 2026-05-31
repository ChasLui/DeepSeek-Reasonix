import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { getDb, resetDb } from "../src/storage/db.js";
import {
  listUnlockedTools,
  nextUnlockSeq,
  recordUnlock,
} from "../src/storage/unlocked-tools-repo.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-tier-")), "reasonix.db");
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: "read_file", description: "read a file", fn: () => "ok" });
  r.register({ name: "edit_file", description: "edit a file", fn: () => "ok" });
  r.register({
    name: "gh_create_issue",
    description: "create a GitHub issue",
    fn: () => "ok",
  });
  return r;
}

afterEach(() => resetDb());

describe("ToolRegistry tiering (Task 3.1)", () => {
  it("filteredSpecs(≥0) === specs() until a tier is assigned (FR-010 byte-identical)", () => {
    const r = reg();
    expect(JSON.stringify(r.filteredSpecs(PREFIX_MAX_TIER))).toBe(JSON.stringify(r.specs()));
    expect(JSON.stringify(r.filteredSpecs(0))).toBe(JSON.stringify(r.specs()));
  });

  it("filteredSpecs drops tools above maxTier, preserving order", () => {
    const r = reg();
    expect(r.setTier("gh_create_issue", 2)).toBe(true);
    const names = r.filteredSpecs(PREFIX_MAX_TIER).map((s) => s.function.name);
    expect(names).toEqual(["read_file", "edit_file"]);
    // still dispatchable / present in the registry, just not in the prefix slice
    expect(r.has("gh_create_issue")).toBe(true);
    expect(r.tierOf("gh_create_issue")).toBe(2);
  });

  it("specOf shape is identical to that tool's entry in specs() (FR-004 同构)", () => {
    const r = reg();
    const fromList = r.specs().find((s) => s.function.name === "read_file");
    expect(JSON.stringify(r.specOf("read_file"))).toBe(JSON.stringify(fromList));
    expect(r.specOf("nope")).toBeUndefined();
  });

  it("setTier returns false for unknown names; tierOf defaults to 0", () => {
    const r = reg();
    expect(r.setTier("nope", 2)).toBe(false);
    expect(r.tierOf("nope")).toBe(0);
    expect(r.tierOf("read_file")).toBe(0);
  });
});

describe("FR-011 unknown-tool hint gating", () => {
  it("plain error when search_tools is NOT registered (FR-010 byte-identical)", async () => {
    const r = reg();
    const out = await r.dispatch("ghost_tool", "{}", {});
    expect(out).toContain("unknown tool: ghost_tool");
    expect(out).not.toMatch(/search_tools/);
  });

  it("points at search_tools when it IS registered", async () => {
    const r = reg();
    r.register({ name: "search_tools", description: "search", fn: () => "ok" });
    const out = await r.dispatch("ghost_tool", "{}", {});
    expect(out).toContain("unknown tool: ghost_tool");
    expect(out).toMatch(/search_tools/);
  });
});

describe("unlock mechanism (Task 3.3): specOf + addTool idempotent + epoch", () => {
  it("addTool(specOf) promotes a deferred tool once and syncs via epoch", () => {
    const r = reg();
    r.setTier("gh_create_issue", 2);
    const prefix = new ImmutablePrefix({
      system: "s",
      toolSpecs: r.filteredSpecs(PREFIX_MAX_TIER),
    });
    const epochs: string[] = [];
    prefix.onEpoch((e) => epochs.push(`${e.type}:${e.name}`));

    expect(prefix.toolSpecs.map((t) => t.function?.name)).toEqual(["read_file", "edit_file"]);
    // first unlock: addTool succeeds, emits one epoch
    const spec = r.specOf("gh_create_issue")!;
    expect(prefix.addTool(spec)).toBe(true);
    // second unlock attempt: idempotent no-op, no epoch
    expect(prefix.addTool(spec)).toBe(false);
    expect(epochs).toEqual(["add:gh_create_issue"]);
    expect(prefix.toolSpecs.map((t) => t.function?.name)).toContain("gh_create_issue");
  });
});

describe("session_unlocked_tools repo (migration v7, FR-006)", () => {
  it("records unlocks in monotonic seq order, idempotently", () => {
    const db = getDb(tmpDbPath());
    const at = "2026-05-31T00:00:00.000Z";
    expect(nextUnlockSeq(db, "sess-a")).toBe(0);

    recordUnlock(db, "sess-a", "mcp", "gh_create_issue", 0, at);
    recordUnlock(db, "sess-a", "mcp", "gh_list_prs", 1, at);
    // re-unlock same tool: PK(session,name) → INSERT OR IGNORE, no dupe
    recordUnlock(db, "sess-a", "mcp", "gh_create_issue", 99, at);

    const rows = listUnlockedTools(db, "sess-a");
    expect(rows.map((r) => r.name)).toEqual(["gh_create_issue", "gh_list_prs"]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(nextUnlockSeq(db, "sess-a")).toBe(2);
  });

  it("scopes by session; fresh session starts at seq 0", () => {
    const db = getDb(tmpDbPath());
    recordUnlock(db, "sess-a", "mcp", "t1", 0, "2026-05-31T00:00:00.000Z");
    expect(listUnlockedTools(db, "sess-b")).toEqual([]);
    expect(nextUnlockSeq(db, "sess-b")).toBe(0);
  });
});

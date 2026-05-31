import { describe, expect, it } from "vitest";
import type { ReasonixConfig } from "../src/config.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";
import {
  activateToolTiering,
  applyMcpServerTier,
  buildCapabilityHint,
} from "../src/tools/tiering.js";

function builtinReg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of ["read_file", "edit_file", "run_command"]) {
    r.register({ name: n, description: `builtin ${n}`, fn: () => "ok" });
  }
  return r;
}

function withMcp(r: ToolRegistry, server: string, count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${server}_op${i}`;
    r.register({
      name,
      description: `${server} operation ${i}`,
      fn: () => "ok",
    });
    names.push(name);
  }
  return names;
}

describe("buildCapabilityHint (FR-009)", () => {
  it("empty for no deferred tools and no skills (FR-010 byte-identical)", () => {
    expect(buildCapabilityHint([])).toBe("");
    expect(buildCapabilityHint([], 0)).toBe("");
  });

  it("groups by server, sorted, with counts, and points at search_tools", () => {
    const hint = buildCapabilityHint(["github_create_issue", "github_list_prs", "slack_post"]);
    expect(hint).toMatch(/search_tools/);
    expect(hint).toMatch(/3 tool\(s\)/);
    // alphabetical: github before slack
    expect(hint.indexOf("github (2)")).toBeGreaterThan(0);
    expect(hint.indexOf("slack (1)")).toBeGreaterThan(0);
    expect(hint.indexOf("github (2)")).toBeLessThan(hint.indexOf("slack (1)"));
  });

  it("adds a skills note + run_skill guidance when the index overflowed", () => {
    const hint = buildCapabilityHint([], 12);
    expect(hint).toMatch(/search_tools/);
    expect(hint).toMatch(/run_skill/);
  });
});

describe("applyMcpServerTier (mcpDeferThreshold)", () => {
  it("no-op below threshold", () => {
    const r = builtinReg();
    const names = withMcp(r, "github", 3);
    applyMcpServerTier(r, names, { toolTiers: { mcpDeferThreshold: 5 } });
    expect(names.every((n) => r.tierOf(n) === 0)).toBe(true);
  });

  it("defers all of a server's tools at/above threshold", () => {
    const r = builtinReg();
    const names = withMcp(r, "github", 6);
    applyMcpServerTier(r, names, { toolTiers: { mcpDeferThreshold: 5 } });
    expect(names.every((n) => r.tierOf(n) === 2)).toBe(true);
  });
});

describe("activateToolTiering — FR-010 gate", () => {
  it("no toolTiers config → no-op, search_tools NOT registered, prefix unchanged", () => {
    const r = builtinReg();
    const before = JSON.stringify(r.filteredSpecs(PREFIX_MAX_TIER));
    const res = activateToolTiering(r, {} as ReasonixConfig, null);
    expect(res).toEqual({
      deferredCount: 0,
      capabilityHint: "",
      searchToolsRegistered: false,
    });
    expect(r.has("search_tools")).toBe(false);
    expect(JSON.stringify(r.filteredSpecs(PREFIX_MAX_TIER))).toBe(before);
  });

  it("deferring tools registers search_tools, emits hint, drops deferred from the prefix slice", () => {
    const r = builtinReg();
    const names = withMcp(r, "github", 4);
    const cfg: ReasonixConfig = {
      toolTiers: { tiers: Object.fromEntries(names.map((n) => [n, 2])) },
    };
    const res = activateToolTiering(r, cfg, null);
    expect(res.deferredCount).toBe(4);
    expect(res.searchToolsRegistered).toBe(true);
    expect(res.capabilityHint).toMatch(/search_tools/);

    const prefixNames = r.filteredSpecs(PREFIX_MAX_TIER).map((s) => s.function.name);
    // deferred github_* excluded; search_tools (Tier 0) included
    expect(prefixNames).toContain("search_tools");
    expect(prefixNames.some((n) => n.startsWith("github_"))).toBe(false);
    // but the deferred tools are still registered + dispatchable
    expect(r.has("github_op0")).toBe(true);
    expect(r.tierOf("github_op0")).toBe(2);
  });
});

describe("E2E: ≥100 deferred tools (SC-003 mechanism)", () => {
  it("initial prefix holds only Tier0/1 + search_tools; fingerprint stable; one unlock = one change", () => {
    const r = builtinReg();
    const names = withMcp(r, "huge", 100);
    const cfg: ReasonixConfig = { toolTiers: { mcpDeferThreshold: 50 } };
    applyMcpServerTier(r, names, cfg);
    const res = activateToolTiering(r, cfg, null);
    expect(res.deferredCount).toBe(100);

    const initial = r.filteredSpecs(PREFIX_MAX_TIER);
    const initialNames = initial.map((s) => s.function.name);
    // none of the 100 deferred tools are in the prefix
    expect(initialNames.filter((n) => n.startsWith("huge_"))).toEqual([]);
    expect(initialNames).toContain("search_tools");
    expect(initial.length).toBe(3 /* builtins */ + 1 /* search_tools */);

    // fingerprint is identical when built twice from the same slice
    const p1 = new ImmutablePrefix({ system: "s", toolSpecs: initial });
    const p2 = new ImmutablePrefix({
      system: "s",
      toolSpecs: r.filteredSpecs(PREFIX_MAX_TIER),
    });
    expect(p1.fingerprint).toBe(p2.fingerprint);

    // unlocking exactly one deferred tool changes the fingerprint exactly once
    const before = p1.fingerprint;
    const spec = r.specOf("huge_op7")!;
    expect(p1.addTool(spec)).toBe(true);
    expect(p1.fingerprint).not.toBe(before);
    const afterFirst = p1.fingerprint;
    // idempotent re-unlock: no further change, no drift
    expect(p1.addTool(spec)).toBe(false);
    expect(p1.fingerprint).toBe(afterFirst);
    expect(() => p1.verifyFingerprint()).not.toThrow();
  });
});

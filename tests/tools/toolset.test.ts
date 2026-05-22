import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReasonixConfig } from "../../src/config.js";
import { resolveSessionToolset } from "../../src/config.js";
import { ToolRegistry } from "../../src/tools.js";
import { ESSENTIAL_TOOLS, applySessionToolset, isToolSelected } from "../../src/tools/toolset.js";

function writeCfg(cfg: Partial<ReasonixConfig>): string {
  const dir = mkdtempSync(join(tmpdir(), "toolset-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

function reg(...names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register({ name: n, fn: () => "" });
  return r;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSessionToolset", () => {
  it("returns null when no selection is configured (all tools load)", () => {
    expect(resolveSessionToolset(writeCfg({}))).toBeNull();
  });

  it("REASONIX_TOOLGATE=0 disables gating even with a defaultToolset", () => {
    vi.stubEnv("REASONIX_TOOLGATE", "0");
    const p = writeCfg({
      defaultToolset: "web",
      toolsets: { web: ["web_search"] },
    });
    expect(resolveSessionToolset(p)).toBeNull();
  });

  it("expands a group name via config.toolsets", () => {
    const p = writeCfg({
      toolsets: { web: ["web_search", "web_fetch"] },
      defaultToolset: "web",
    });
    expect(resolveSessionToolset(p)).toEqual(new Set(["web_search", "web_fetch"]));
  });

  it("treats an unknown token as a literal tool name", () => {
    expect(resolveSessionToolset(writeCfg({ defaultToolset: "glob" }))).toEqual(new Set(["glob"]));
  });

  it("a defaultToolset array mixes group names and literal tool names", () => {
    const p = writeCfg({
      toolsets: { web: ["web_search"] },
      defaultToolset: ["web", "glob"],
    });
    expect(resolveSessionToolset(p)).toEqual(new Set(["web_search", "glob"]));
  });

  it("env REASONIX_TOOLSET overrides config.defaultToolset", () => {
    vi.stubEnv("REASONIX_TOOLSET", "glob");
    const p = writeCfg({
      defaultToolset: "web",
      toolsets: { web: ["web_search"] },
    });
    expect(resolveSessionToolset(p)).toEqual(new Set(["glob"]));
  });

  it("splits comma-separated env tokens and trims them", () => {
    vi.stubEnv("REASONIX_TOOLSET", "glob, web_fetch");
    expect(resolveSessionToolset(writeCfg({}))).toEqual(new Set(["glob", "web_fetch"]));
  });

  it("tolerates a malformed toolsets group (non-string entries) without throwing", () => {
    const p = writeCfg({
      toolsets: { web: [1, "web_fetch"] as unknown as string[] },
      defaultToolset: "web",
    });
    expect(() => resolveSessionToolset(p)).not.toThrow();
    expect(resolveSessionToolset(p)).toEqual(new Set(["web_fetch"]));
  });

  it("blank REASONIX_TOOLSET falls back to config, not all-tools", () => {
    vi.stubEnv("REASONIX_TOOLSET", "  ");
    expect(resolveSessionToolset(writeCfg({ defaultToolset: "glob" }))).toEqual(new Set(["glob"]));
  });
});

describe("applySessionToolset", () => {
  it("null selection leaves the registry unchanged", () => {
    const r = reg("read_file", "glob", "web_search");
    applySessionToolset(r, null);
    expect(r.size).toBe(3);
  });

  it("undefined tools is a no-op (does not throw)", () => {
    expect(() => applySessionToolset(undefined, new Set(["glob"]))).not.toThrow();
  });

  it("prunes to selection while always keeping essential tools", () => {
    const r = reg("read_file", "glob", "web_search", "edit_file");
    applySessionToolset(r, new Set(["web_search"]));
    expect(r.has("web_search")).toBe(true); // selected
    expect(r.has("read_file")).toBe(true); // essential
    expect(r.has("edit_file")).toBe(true); // essential
    expect(r.has("glob")).toBe(false); // neither → pruned
  });

  it("keeps an essential tool even when it is not in the selection", () => {
    const r = reg("read_file", "glob");
    applySessionToolset(r, new Set(["glob"]));
    expect(r.has("read_file")).toBe(true);
    expect([...ESSENTIAL_TOOLS]).toContain("read_file");
  });

  it("preserves insertion order — the kept specs are a subsequence", () => {
    const r = reg("read_file", "glob", "web_search", "edit_file");
    applySessionToolset(r, new Set(["web_search"]));
    expect(r.specs().map((s) => s.function.name)).toEqual(["read_file", "web_search", "edit_file"]);
  });
});

describe("isToolSelected", () => {
  it("null selection accepts any tool (gating off)", () => {
    expect(isToolSelected("anything", null)).toBe(true);
  });

  it("accepts a selected tool", () => {
    expect(isToolSelected("web_search", new Set(["web_search"]))).toBe(true);
  });

  it("rejects an unselected non-essential tool", () => {
    expect(isToolSelected("web_search", new Set(["glob"]))).toBe(false);
  });

  it("always accepts an essential tool even when unselected", () => {
    expect(isToolSelected("read_file", new Set(["glob"]))).toBe(true);
  });
});

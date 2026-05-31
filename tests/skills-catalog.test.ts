import { describe, expect, it } from "vitest";
import type { ReasonixConfig } from "../src/config.js";
import { type CatalogSkill, skillsIndexExceedsCap } from "../src/skills.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { registerSearchTools } from "../src/tools/search-tools.js";
import { activateToolTiering, skillCatalogInputs } from "../src/tools/tiering.js";

function skill(name: string, description: string): CatalogSkill {
  return { name, description, runAs: "inline" };
}

// ~50 skills × ~120-char descriptions ≫ 4000-char index cap.
function overflowingSkills(): CatalogSkill[] {
  return Array.from({ length: 50 }, (_, i) =>
    skill(
      `skill_${i.toString().padStart(2, "0")}`,
      `does a fairly elaborate thing number ${i} with enough words here to push the rendered skills index well past the prefix cap`,
    ),
  );
}

function builtinReg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: "read_file", description: "read a file", fn: () => "ok" });
  return r;
}

describe("skillsIndexExceedsCap (Task 5.2)", () => {
  it("false for empty / small skill sets, true on overflow", () => {
    expect(skillsIndexExceedsCap([])).toBe(false);
    expect(skillsIndexExceedsCap([skill("explore", "look around")])).toBe(false);
    expect(skillsIndexExceedsCap(overflowingSkills())).toBe(true);
  });
});

describe("skillCatalogInputs (Task 5.1)", () => {
  it("maps skills to source=skill catalog entries with empty params", () => {
    const inputs = skillCatalogInputs([skill("explore", "investigate code")]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.source).toBe("skill");
    expect(inputs[0]!.spec.function.name).toBe("explore");
    expect(inputs[0]!.spec.function.description).toBe("investigate code");
  });

  it("skills are findable in a built catalog", () => {
    const cat = ToolCatalog.build(
      skillCatalogInputs([
        skill("explore", "investigate the codebase and report findings"),
        skill("ralplan", "draft a RAL implementation plan"),
      ]),
    );
    const hits = cat.search("investigate the codebase", 5).map((h) => h.name);
    expect(hits).toContain("explore");
  });
});

describe("activateToolTiering with skills (Task 5.1/5.2 gate)", () => {
  it("non-overflowing skills + no deferred tools → no-op (FR-010 byte-identical)", () => {
    const r = builtinReg();
    const res = activateToolTiering(r, {} as ReasonixConfig, null, [
      skill("explore", "look around"),
    ]);
    expect(res.searchToolsRegistered).toBe(false);
    expect(res.capabilityHint).toBe("");
    expect(r.has("search_tools")).toBe(false);
  });

  it("overflowing skills register search_tools + hint, even with zero deferred tools", () => {
    const r = builtinReg();
    const res = activateToolTiering(r, {} as ReasonixConfig, null, overflowingSkills());
    expect(res.deferredCount).toBe(0);
    expect(res.searchToolsRegistered).toBe(true);
    expect(res.capabilityHint).toMatch(/run_skill/);
    // search_tools is a Tier-0 prefix tool now
    expect(r.filteredSpecs(PREFIX_MAX_TIER).map((s) => s.function.name)).toContain("search_tools");
  });
});

describe("search_tools surfaces skills with a run_skill hint (Task 5.1)", () => {
  it("a skill hit tells the model to invoke run_skill, not call it directly", async () => {
    const reg = new ToolRegistry();
    const cat = ToolCatalog.build(
      skillCatalogInputs([skill("explore", "investigate the codebase and summarize findings")]),
    );
    registerSearchTools(reg, { catalog: cat });
    const out = await reg.dispatch(
      "search_tools",
      JSON.stringify({ query: "investigate the codebase" }),
      {},
    );
    expect(out).toMatch(/explore \(skill\)/);
    expect(out).toMatch(/run_skill/);
  });
});

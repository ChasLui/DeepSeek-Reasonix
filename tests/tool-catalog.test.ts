import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { GOLDEN_NEGATIVE, GOLDEN_RECALL } from "../src/tools/catalog.golden.js";
import { type CatalogToolInput, type EmbedFn, ToolCatalog } from "../src/tools/catalog.js";
import { registerChoiceTool } from "../src/tools/choice.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";
import { JobRegistry } from "../src/tools/jobs.js";
import { registerMemoryTools } from "../src/tools/memory.js";
import { registerPlanTool } from "../src/tools/plan.js";
import { registerScaffoldTools } from "../src/tools/scaffold.js";
import { registerSearchTools } from "../src/tools/search-tools.js";
import { registerShellTools } from "../src/tools/shell.js";
import { registerSkillTools } from "../src/tools/skills.js";
import { registerTodoTool } from "../src/tools/todo.js";
import { registerWebTools } from "../src/tools/web.js";

// Real builtin registry (same set measure-tool-token-cost.mts uses) → real tool
// descriptions, so bm25 recall reflects production text. Index-graph tools
// (find_references/impact/…) need registerCodeQueryTools + a graph; they're
// out of this unit's scope (covered by Slice 3 E2E) — golden cases for tools
// NOT in the catalog are filtered out, and coverage is asserted ≥ a floor.

let cat: ToolCatalog;
let names: Set<string>;
let root: string;
let home: string;
let jobs: JobRegistry;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "reasonix-catalog-test-"));
  home = mkdtempSync(join(tmpdir(), "reasonix-catalog-test-home-"));
  const tools = new ToolRegistry();
  jobs = new JobRegistry();
  registerFilesystemTools(tools, { rootDir: root });
  registerShellTools(tools, { rootDir: root, jobs, allowAll: true });
  registerMemoryTools(tools, { projectRoot: root });
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerScaffoldTools(tools, {
    homeDir: home,
    projectRoot: root,
    configPath: join(home, "config.json"),
  });
  registerWebTools(tools);
  registerSkillTools(tools, { projectRoot: root, disableBuiltins: true });

  const inputs: CatalogToolInput[] = tools
    .specs()
    .map((spec) => ({ source: "builtin", tier: 2, spec }));
  cat = ToolCatalog.build(inputs);
  names = new Set(inputs.map((i) => i.spec.function?.name ?? ""));
});

afterAll(async () => {
  await jobs.shutdown(1000);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("ToolCatalog.build", () => {
  it("indexes every spec with a name", () => {
    expect(cat.size).toBe(names.size);
    expect(cat.size).toBeGreaterThan(20);
  });
});

describe("SC-002 recall (bm25-only, 现网无 provider)", () => {
  it("GOLDEN_RECALL top-8 recall ≥ 0.70 over catalog-present tools", () => {
    const applicable = GOLDEN_RECALL.filter((g) => names.has(g.expectedTool));
    // Guard against silently shrinking coverage to a trivially-passable few.
    expect(applicable.length).toBeGreaterThanOrEqual(12);

    let hit = 0;
    const misses: string[] = [];
    for (const g of applicable) {
      const top = cat.search(g.query, 8).map((h) => h.name);
      if (top.includes(g.expectedTool)) hit++;
      else misses.push(`${g.expectedTool} <= "${g.query}" -> [${top.slice(0, 3).join(", ")}]`);
    }
    const recall = hit / applicable.length;
    if (recall < 0.7) console.error(`recall misses:\n${misses.join("\n")}`);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });
});

describe("SC-002 precision (negative / confusable traps)", () => {
  it("bm25-only precision baseline — hybrid (FR-003) is expected to lift this", () => {
    const applicable = GOLDEN_NEGATIVE.filter((g) => names.has(g.expectedTool));
    expect(applicable.length).toBeGreaterThanOrEqual(5);

    let clean = 0;
    for (const g of applicable) {
      const ranked = cat.search(g.query, 20).map((h) => h.name);
      const expectedRank = ranked.indexOf(g.expectedTool);
      if (expectedRank === -1) continue; // not retrieved → not a precision win, skip
      const present = g.confusableWith.filter((c) => names.has(c) && ranked.includes(c));
      const beatsAll = present.every((c) => ranked.indexOf(c) > expectedRank);
      if (beatsAll) clean++;
    }
    const precision = clean / applicable.length;
    // EVIDENCE for the plan's hybrid design (validates critic's precision worry):
    // a pure-lexical retriever legitimately confuses near-synonym tools
    // (search_files↔glob, stop_job↔wait_job). Lifting precision is exactly what
    // the semantic arm (FR-003 hybrid) is for — asserted once an
    // EmbeddingProvider is configured. This floor only guards total collapse.
    console.log(
      `bm25-only precision@confusable = ${precision.toFixed(2)} (${clean}/${applicable.length}) — hybrid should raise this`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.5);
  });
});

describe("search invariants", () => {
  it("clamps limit to [1,20]", () => {
    expect(cat.search("read a file", 999).length).toBeLessThanOrEqual(20);
    expect(cat.search("read a file", 0).length).toBeLessThanOrEqual(1);
  });

  it("returns paramsSummary that never drops a required arg", () => {
    const hits = cat.search("read the contents of a file", 8);
    const rf = hits.find((h) => h.name === "read_file");
    expect(rf).toBeDefined();
    // read_file requires `path` — summary must surface it.
    expect(rf?.paramsSummary).toMatch(/required:.*path/);
  });
});

describe("searchHybrid degradation (NF-002)", () => {
  it("no embedder → identical to bm25 search", async () => {
    const lex = cat.search("run a shell command", 8).map((h) => h.name);
    const hyb = (await cat.searchHybrid("run a shell command", 8)).map((h) => h.name);
    expect(hyb).toEqual(lex);
  });

  it("embedder that throws → falls back to bm25 (no crash)", async () => {
    const boom: EmbedFn = async () => {
      throw new Error("provider down");
    };
    const hyb = await cat.searchHybrid("read a file", 8, boom);
    expect(hyb.length).toBeGreaterThan(0);
    expect(hyb.map((h) => h.name)).toContain("read_file");
  });

  it("working embedder → fuses without crashing, respects limit", async () => {
    // Deterministic toy embedder: bag-of-chars vector. Exercises cosine + RRF;
    // not a quality assertion.
    const dim = 32;
    const toy: EmbedFn = async (text: string) => {
      const v = new Float32Array(dim);
      for (const ch of text.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (c >= 97 && c <= 122) v[(c - 97) % dim] += 1;
      }
      return v;
    };
    const hyb = await cat.searchHybrid("delete a directory", 5, toy);
    expect(hyb.length).toBeGreaterThan(0);
    expect(hyb.length).toBeLessThanOrEqual(5);
  });
});

describe("search_tools meta-tool (FR-003 / FR-010 gate)", () => {
  it("FR-010 gate: enabled=false → not registered", () => {
    const reg = new ToolRegistry();
    const registered = registerSearchTools(reg, {
      catalog: cat,
      enabled: false,
    });
    expect(registered).toBe(false);
    expect(reg.specs().some((s) => s.function?.name === "search_tools")).toBe(false);
  });

  it("registers and dispatch returns ranked tools", async () => {
    const reg = new ToolRegistry();
    expect(registerSearchTools(reg, { catalog: cat })).toBe(true);
    expect(reg.specs().some((s) => s.function?.name === "search_tools")).toBe(true);
    const out = await reg.dispatch("search_tools", JSON.stringify({ query: "read a file" }), {});
    expect(out).toContain("read_file");
  });

  it("empty query → guidance, no crash", async () => {
    const reg = new ToolRegistry();
    registerSearchTools(reg, { catalog: cat });
    const out = await reg.dispatch("search_tools", JSON.stringify({ query: "   " }), {});
    expect(out).toMatch(/query/i);
  });

  it("no match → graceful message", async () => {
    const reg = new ToolRegistry();
    registerSearchTools(reg, { catalog: cat });
    const out = await reg.dispatch(
      "search_tools",
      JSON.stringify({ query: "zzqqx nonexistent capability wxyz" }),
      {},
    );
    expect(out).toMatch(/No tools matched|Found/);
  });

  it("isUnlocked tags already-available tools", async () => {
    const reg = new ToolRegistry();
    registerSearchTools(reg, {
      catalog: cat,
      isUnlocked: (_s, n) => n === "read_file",
    });
    const out = await reg.dispatch("search_tools", JSON.stringify({ query: "read a file" }), {});
    expect(out).toMatch(/read_file.*already available/);
  });
});

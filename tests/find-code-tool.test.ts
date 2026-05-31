import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeLexicalIndex } from "../src/index/lexical/code.js";
import { FIXTURE_FILES } from "../src/index/retrieval/golden.js";
import { registerFindCodeTool } from "../src/index/retrieval/tool.js";
import { ToolRegistry } from "../src/tools.js";

const roots: string[] = [];

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-findcode-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

async function callFindCode(reg: ToolRegistry, query: string): Promise<string> {
  const def = reg.get("find_code");
  if (!def) throw new Error("find_code not registered");
  return (await def.fn({ query })) as string;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("find_code tool registration (FR-003 / P2-1)", () => {
  it("registers as a Tier 0 tool that enters specs (→ prefix → repair allowedToolNames)", () => {
    const reg = new ToolRegistry();
    registerFindCodeTool(reg, "/tmp/whatever");
    expect(reg.has("find_code")).toBe(true);
    expect(reg.tierOf("find_code")).toBe(0);
    expect(reg.specs().some((s) => s.function.name === "find_code")).toBe(true);
  });

  it("alias-only: registering find_code does not register/unregister semantic_search", () => {
    const reg = new ToolRegistry();
    registerFindCodeTool(reg, "/tmp/x");
    expect(reg.has("semantic_search")).toBe(false);
  });
});

describe("find_code tool behavior — degradation never throws (FR-004)", () => {
  it("returns ranked results pointing at the right file on a built index", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const reg = new ToolRegistry();
    registerFindCodeTool(reg, root);
    const out = await callFindCode(reg, "PrefixCache");
    expect(out).toContain("src/cache/prefix.ts");
    expect(out).toContain("results");
  });

  it("cold repo with no index returns guidance, not an error", async () => {
    const empty = mkdtempSync(join(tmpdir(), "reasonix-findcode-empty-"));
    roots.push(empty);
    const reg = new ToolRegistry();
    registerFindCodeTool(reg, empty);
    const out = await callFindCode(reg, "anything at all");
    expect(out).toContain("no code matches");
  });
});

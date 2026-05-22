import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandAtMentions } from "../src/at-mentions.js";
import { codeSystemPrompt } from "../src/code/prompt.js";
import { MemoryStore, applyUserMemory } from "../src/memory/user.js";
import { getToonStats, resetToonStats } from "../src/toon/stats.js";

describe("TOON prefix payloads", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-toon-prefix-root-"));
    home = mkdtempSync(join(tmpdir(), "reasonix-toon-prefix-home-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "loop.ts"), "export const x = 1;\n");
    resetToonStats();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps @mention XML payloads unchanged when prefix TOON is off", () => {
    const out = expandAtMentions("look at @src/loop.ts", root, { toonMode: "off" }).text;

    expect(out).toContain('<file path="src/loop.ts">');
    expect(out).not.toContain("```toon");
  });

  it("encodes @mention referenced files as deterministic TOON when prefix mode is on", () => {
    const first = expandAtMentions("look at @src/loop.ts and @src", root, {
      toonMode: "prefix",
    }).text;
    const second = expandAtMentions("look at @src/loop.ts and @src", root, {
      toonMode: "prefix",
    }).text;

    expect(first).toBe(second);
    expect(first).toContain("[Referenced files]");
    expect(first).toContain("```toon");
    expect(first).toContain("referencedFiles[2]:");
    expect(first).toContain("kind: file");
    expect(first).toContain("kind: directory");
    expect(first).not.toContain('<file path="src/loop.ts">');
  });

  it("encodes memory summaries as TOON while preserving high-priority text separately", () => {
    const store = new MemoryStore({ homeDir: home, projectRoot: root });
    store.write({
      name: "pref_one",
      type: "user",
      scope: "global",
      description: "prefers tabs",
      body: "body stays in the recallable detail file",
    });

    const out = applyUserMemory("BASE", { homeDir: home, projectRoot: root, toonMode: "prefix" });

    expect(out).toContain("# User memory index");
    expect(out).toContain("```toon");
    expect(out).toContain("memories[1]{scope,type,name,description}:");
    expect(out).toContain("global,user,pref_one,prefers tabs");
    expect(out).not.toContain("# User memory — global");
  });

  it("encodes gitignore and skills index as deterministic TOON in code prompts", () => {
    writeFileSync(join(root, ".gitignore"), "dist\ncoverage\n");

    const first = codeSystemPrompt(root, { toonMode: "prefix" });
    const second = codeSystemPrompt(root, { toonMode: "prefix" });

    expect(first).toBe(second);
    expect(first).toContain("# Skills — playbooks you can invoke");
    expect(first).toContain("skills[");
    expect(first).toContain("# Project .gitignore");
    expect(first).toContain("gitignore:");
    expect(first).toContain("patterns[2]: dist,coverage");

    const stats = getToonStats();
    expect(stats.layers["prompt-prefix"].hits).toBeGreaterThanOrEqual(2);
    expect(stats.layers["prompt-prefix"].jsonTokens).toBeGreaterThan(0);
    expect(stats.fallbacks.encode).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { PromptFingerprint } from "../../src/cache/prompt-fingerprint.js";
import { ImmutablePrefix } from "../../src/memory/runtime.js";
import type { ToolSpec } from "../../src/types.js";

describe("PromptFingerprint", () => {
  it("makes systemHash whitespace-sensitive", () => {
    const fp = new PromptFingerprint();
    const a = fp.snapshot(new ImmutablePrefix({ system: "system" }));
    const b = fp.snapshot(new ImmutablePrefix({ system: "system " }));

    expect(b.systemHash).not.toBe(a.systemHash);
  });

  it("detects tool order in toolsHash while keeping per-tool hashes stable", () => {
    const fp = new PromptFingerprint();
    const a = fp.snapshot(new ImmutablePrefix({ system: "x", toolSpecs: [tool("a"), tool("b")] }));
    const b = fp.snapshot(new ImmutablePrefix({ system: "x", toolSpecs: [tool("b"), tool("a")] }));

    expect(b.toolsHash).not.toBe(a.toolsHash);
    expect([...b.perToolHashes].sort()).toEqual([...a.perToolHashes].sort());
  });

  it("keeps snapshots independent from later prefix mutation", () => {
    const fp = new PromptFingerprint();
    const prefix = new ImmutablePrefix({ system: "x", toolSpecs: [tool("a")] });
    const before = fp.snapshot(prefix);

    prefix.addTool(tool("b"));
    const after = fp.snapshot(prefix);

    expect(fp.diff(before, after)).toMatchObject({
      systemChanged: false,
      toolsChanged: true,
      addedToolNames: ["b"],
      removedToolNames: [],
      changedToolNames: [],
    });
    expect(before.toolCount).toBe(1);
    expect([...before.perToolHashes.keys()]).toEqual(["a"]);
  });

  it("returns an empty diff for the initial snapshot", () => {
    const fp = new PromptFingerprint();
    const snapshot = fp.snapshot(new ImmutablePrefix({ system: "x", toolSpecs: [tool("a")] }));

    expect(fp.diff(null, snapshot)).toEqual({
      systemChanged: false,
      toolsChanged: false,
      changedToolNames: [],
      addedToolNames: [],
      removedToolNames: [],
      systemCharDelta: 0,
    });
  });

  it("changes toolsHash when strict is injected — caller must accept cache reset", () => {
    const fp = new PromptFingerprint();
    const before = fp.snapshot(
      new ImmutablePrefix({ system: "x", toolSpecs: [tool("a"), tool("b")] }),
    );
    const after = fp.snapshot(
      new ImmutablePrefix({
        system: "x",
        toolSpecs: [strictTool("a"), strictTool("b")],
      }),
    );

    // Plan Open Q-7: toolsStrict:true on existing tools is a known cache-invalidator.
    // Lock the contract: hashes must diverge so callers don't silently believe
    // the cache survived a strict-mode flip.
    expect(after.toolsHash).not.toBe(before.toolsHash);
    expect([...after.perToolHashes.keys()].sort()).toEqual(["a", "b"]);
  });

  it("keeps toolsHash stable across snapshots when nothing changes", () => {
    const fp = new PromptFingerprint();
    const a = fp.snapshot(new ImmutablePrefix({ system: "x", toolSpecs: [tool("a"), tool("b")] }));
    const b = fp.snapshot(new ImmutablePrefix({ system: "x", toolSpecs: [tool("a"), tool("b")] }));
    expect(a.toolsHash).toBe(b.toolsHash);
  });
});

function strictTool(name: string): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description: "description",
      parameters: { type: "object" },
      strict: true,
    },
  };
}

function tool(name: string): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description: "description",
      parameters: { type: "object" },
    },
  };
}

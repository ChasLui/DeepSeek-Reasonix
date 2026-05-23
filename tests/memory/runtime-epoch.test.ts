import { describe, expect, it, vi } from "vitest";
import { ImmutablePrefix } from "../../src/memory/runtime.js";
import type { ToolSpec } from "../../src/types.js";

describe("ImmutablePrefix epoch events", () => {
  it("emits addTool events after successful mutation", () => {
    const prefix = new ImmutablePrefix({ system: "x" });
    const events: unknown[] = [];
    prefix.onEpoch((evt) => events.push(evt));

    expect(prefix.addTool(tool("alpha"))).toBe(true);
    expect(events).toEqual([{ type: "add", name: "alpha" }]);
  });

  it("emits removeTool events after successful mutation", () => {
    const prefix = new ImmutablePrefix({
      system: "x",
      toolSpecs: [tool("alpha")],
    });
    const events: unknown[] = [];
    prefix.onEpoch((evt) => events.push(evt));

    expect(prefix.removeTool("alpha")).toBe(true);
    expect(events).toEqual([{ type: "remove", name: "alpha" }]);
  });

  it("unregisters listeners", () => {
    const prefix = new ImmutablePrefix({ system: "x" });
    const events: unknown[] = [];
    const unregister = prefix.onEpoch((evt) => events.push(evt));

    unregister();
    expect(prefix.addTool(tool("alpha"))).toBe(true);
    expect(events).toEqual([]);
  });

  it("keeps verifyFingerprint behavior unchanged", () => {
    const prefix = new ImmutablePrefix({ system: "x" });
    const before = prefix.fingerprint;

    expect(prefix.verifyFingerprint()).toBe(before);
    (prefix as unknown as { _toolSpecs: ToolSpec[] })._toolSpecs.push(tool("rogue"));
    expect(() => prefix.verifyFingerprint()).toThrow(/fingerprint drift/);
  });

  it("treats listener failures as best-effort", () => {
    const prefix = new ImmutablePrefix({ system: "x" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prefix.onEpoch(() => {
      throw new Error("boom");
    });
    const before = prefix.fingerprint;

    expect(prefix.addTool(tool("alpha"))).toBe(true);
    expect(
      (prefix as unknown as { _fingerprintCache: string | null })._fingerprintCache,
    ).toBeNull();
    expect(prefix.fingerprint).not.toBe(before);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it("honors unregister during the same emit", () => {
    const prefix = new ImmutablePrefix({ system: "x" });
    const events: string[] = [];
    let unregisterB = (): void => {};

    prefix.onEpoch(() => {
      events.push("a");
      unregisterB();
    });
    unregisterB = prefix.onEpoch(() => {
      events.push("b");
    });
    prefix.onEpoch(() => {
      events.push("c");
    });

    expect(prefix.addTool(tool("alpha"))).toBe(true);
    expect(events).toEqual(["a", "c"]);
  });
});

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

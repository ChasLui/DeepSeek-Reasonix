import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { ToolSchemaIndex } from "../../src/cache/tool-schema.js";
import type { ToolSpec } from "../../src/types.js";
import { sha256Prefix } from "../../src/utils/sha256.js";

describe("ToolSchemaIndex", () => {
  it("returns stable hashes for identical tool specs", () => {
    const index = new ToolSchemaIndex();
    const specs = [tool("alpha"), tool("bravo")];

    expect([...index.index(specs)]).toEqual([...index.index(specs)]);
  });

  it("diffs added, removed, and changed tools by sorted name", () => {
    const index = new ToolSchemaIndex();
    const prev = index.index([tool("bravo"), tool("delta"), tool("echo", "old")]);
    const next = index.index([tool("alpha"), tool("bravo"), tool("echo", "new")]);

    expect(index.diff(prev, next)).toEqual({
      added: ["alpha"],
      removed: ["delta"],
      changed: ["echo"],
    });
  });

  it("changes the hash when only the description changes", () => {
    const index = new ToolSchemaIndex();
    const before = index.index([tool("alpha", "one")]).get("alpha");
    const after = index.index([tool("alpha", "one!")]).get("alpha");

    expect(after).not.toBe(before);
  });

  it("hashes the OpenAI-compatible function shape, not top-level fields", () => {
    const index = new ToolSchemaIndex();
    const spec = {
      ...tool("alpha", "function description"),
      description: "wrong top-level description",
      parameters: { type: "null" },
    };

    expect(index.index([spec]).get("alpha")).toBe(
      sha256Prefix(
        JSON.stringify({
          name: "alpha",
          description: "function description",
          parameters: { type: "object" },
        }),
      ),
    );
  });

  it("indexes 50 large tool descriptions under the timing sanity bound", () => {
    const index = new ToolSchemaIndex();
    const specs = Array.from({ length: 50 }, (_, i) => tool(`tool_${i}`, "x".repeat(5000)));
    const timings: number[] = [];

    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      index.index(specs);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);

    expect(timings[10]).toBeLessThan(1);
  });
});

function tool(name: string, description = "description"): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object" },
    },
  };
}

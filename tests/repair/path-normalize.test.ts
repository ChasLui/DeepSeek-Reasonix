import { describe, expect, it } from "vitest";
import { ToolCallRepair, normalizeContainerPaths } from "../../src/repair/index.js";
import type { ToolCall } from "../../src/types.js";

function call(name: string, args: unknown): ToolCall {
  return {
    id: "c1",
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

describe("normalizeContainerPaths", () => {
  it("strips /root prefix from path arg on write_file", () => {
    const c = call("write_file", { path: "/root/foo.ts", content: "x" });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(true);
    expect(JSON.parse(c.function.arguments)).toEqual({
      path: "/foo.ts",
      content: "x",
    });
  });

  it("strips from source and destination on move_file", () => {
    const c = call("move_file", {
      source: "/root/a.ts",
      destination: "/root/sub/b.ts",
    });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(true);
    expect(JSON.parse(c.function.arguments)).toEqual({
      source: "/a.ts",
      destination: "/sub/b.ts",
    });
  });

  it("strips from edits[].path on multi_edit", () => {
    const c = call("multi_edit", {
      edits: [
        { path: "/root/a.ts", search: "s", replace: "r" },
        { path: "b.ts", search: "s2", replace: "r2" },
      ],
    });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(c.function.arguments) as {
      edits: Array<{ path: string }>;
    };
    expect(parsed.edits[0]?.path).toBe("/a.ts");
    expect(parsed.edits[1]?.path).toBe("b.ts");
  });

  it("does not touch /Users/, /home/, /tmp/ — only /root", () => {
    const c1 = call("read_file", { path: "/Users/x/a.ts" });
    const c2 = call("read_file", { path: "/home/x/a.ts" });
    const c3 = call("read_file", { path: "/tmp/a.ts" });
    expect(normalizeContainerPaths(c1).changed).toBe(false);
    expect(normalizeContainerPaths(c2).changed).toBe(false);
    expect(normalizeContainerPaths(c3).changed).toBe(false);
  });

  it("does not touch paths whose first segment merely starts with 'root'", () => {
    const c = call("read_file", { path: "/rootkit/x.ts" });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(false);
    expect(JSON.parse(c.function.arguments)).toEqual({ path: "/rootkit/x.ts" });
  });

  it("/root alone becomes '.'", () => {
    const c = call("list_directory", { path: "/root" });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(true);
    expect(JSON.parse(c.function.arguments)).toEqual({ path: "." });
  });

  it("leaves malformed JSON untouched (truncation pass handles those)", () => {
    const c = call("write_file", '{"path":"/root/foo.ts","content":"x');
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(false);
  });

  it("no-op when path arg has no /root", () => {
    const c = call("write_file", { path: "src/foo.ts", content: "x" });
    const r = normalizeContainerPaths(c);
    expect(r.changed).toBe(false);
  });
});

describe("ToolCallRepair pipeline integration — path normalize", () => {
  it("records pathsNormalized in the report", () => {
    const repair = new ToolCallRepair({
      allowedToolNames: new Set(["write_file"]),
    });
    const c: ToolCall = {
      id: "c1",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "/root/foo.ts", content: "x" }),
      },
    };
    const { calls, report } = repair.process([c], null);
    expect(report.pathsNormalized).toBe(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      path: "/foo.ts",
      content: "x",
    });
    expect(report.notes.some((n) => n.includes("/root"))).toBe(true);
  });
});

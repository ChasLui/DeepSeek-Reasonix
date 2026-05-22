import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";

function makeReg() {
  const reg = new ToolRegistry();
  reg.register({
    name: "write_file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["path", "content"],
    },
    fn: async (args: Record<string, unknown>) => `ok:${JSON.stringify(args)}`,
  });
  reg.register({
    name: "search",
    parameters: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" } },
      },
      required: ["terms"],
    },
    fn: async (args: Record<string, unknown>) => `ok:${JSON.stringify(args)}`,
  });
  return reg;
}

describe("dispatch validate-then-repair", () => {
  it("strips null on optional field then dispatches", async () => {
    const reg = makeReg();
    const result = await reg.dispatch(
      "write_file",
      JSON.stringify({ path: "a.ts", content: "x", tags: null }),
    );
    expect(result).toBe('ok:{"path":"a.ts","content":"x"}');
    expect(reg.getRepairStats()).toEqual({ write_file: { "null-strip": 1 } });
  });

  it('parses stringified array \'["a","b"]\' into a real array', async () => {
    const reg = makeReg();
    const result = await reg.dispatch("search", JSON.stringify({ terms: '["a","b"]' }));
    expect(result).toBe('ok:{"terms":["a","b"]}');
    expect(reg.getRepairStats()).toEqual({
      search: { "stringified-array-parsed": 1 },
    });
  });

  it("turns empty placeholder {} into [] at an array field", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("search", JSON.stringify({ terms: {} }));
    expect(result).toBe('ok:{"terms":[]}');
    expect(reg.getRepairStats()).toEqual({
      search: { "empty-placeholder-to-array": 1 },
    });
  });

  it("wraps bare string into single-element array", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("search", JSON.stringify({ terms: "foo" }));
    expect(result).toBe('ok:{"terms":["foo"]}');
    expect(reg.getRepairStats()).toEqual({
      search: { "bare-string-wrapped": 1 },
    });
  });

  it("unwraps degenerate autolink in path", async () => {
    const reg = makeReg();
    const result = await reg.dispatch(
      "write_file",
      JSON.stringify({ path: "[notes.md](http://notes.md)", content: "x" }),
    );
    expect(result).toBe('ok:{"path":"notes.md","content":"x"}');
    expect(reg.getRepairStats()).toEqual({
      write_file: { "autolink-unwrapped": 1 },
    });
  });

  it("returns issue-list detail when not repairable", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", JSON.stringify({ content: 42 }));
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("argument validation failed");
    expect(parsed.error).toContain("path: expected string, got undefined");
    expect(parsed.error).toContain("content: expected string, got number");
  });

  it("legal input runs zero repairs (validator pass on first try)", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", JSON.stringify({ path: "a.ts", content: "x" }));
    expect(result).toBe('ok:{"path":"a.ts","content":"x"}');
    expect(reg.getRepairStats()).toEqual({});
  });

  it("writeFile.content that happens to be JSON-shaped is NOT mistreated as a stringified array", async () => {
    const reg = makeReg();
    const content = '["a","b"]';
    const result = await reg.dispatch("write_file", JSON.stringify({ path: "a.json", content }));
    expect(result).toBe(`ok:{"path":"a.json","content":${JSON.stringify(content)}}`);
    expect(reg.getRepairStats()).toEqual({});
  });

  it("coerces numeric string for optional integer field (P1 #5)", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "read_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, head: { type: "integer" } },
        required: ["path"],
      },
      fn: async (args: Record<string, unknown>) => `ok:${JSON.stringify(args)}`,
    });
    const result = await reg.dispatch("read_file", JSON.stringify({ path: "a.ts", head: "50" }));
    expect(result).toBe('ok:{"path":"a.ts","head":50}');
    expect(reg.getRepairStats()).toEqual({
      read_file: { "numeric-string-coerced": 1 },
    });
  });

  it("rejects enum violation with a readable issue line (P1 #3)", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "set_risk",
      parameters: {
        type: "object",
        properties: { risk: { type: "string", enum: ["low", "med", "high"] } },
        required: ["risk"],
      },
      fn: async (args: Record<string, unknown>) => JSON.stringify(args),
    });
    const result = await reg.dispatch("set_risk", JSON.stringify({ risk: "critical" }));
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("argument validation failed");
    expect(parsed.error).toContain("one of:");
    expect(parsed.error).toContain('"critical"');
  });

  it("autolink sweep does NOT touch write_file.content (P0 #1)", async () => {
    const reg = makeReg();
    const result = await reg.dispatch(
      "write_file",
      JSON.stringify({
        path: "LICENSE.md",
        content: "[LICENSE](http://LICENSE)",
      }),
    );
    expect(result).toBe('ok:{"path":"LICENSE.md","content":"[LICENSE](http://LICENSE)"}');
    expect(reg.getRepairStats()).toEqual({});
  });

  it("unregister clears repair stats and malformed fingerprint (P2 #8)", async () => {
    const reg = makeReg();
    await reg.dispatch(
      "write_file",
      JSON.stringify({ path: "[notes.md](http://notes.md)", content: "x" }),
    );
    expect(reg.getRepairStats()).toEqual({
      write_file: { "autolink-unwrapped": 1 },
    });
    expect(reg.unregister("write_file")).toBe(true);
    expect(reg.getRepairStats()).toEqual({});
  });

  it("resetRepairStats() wipes the counter", async () => {
    const reg = makeReg();
    await reg.dispatch("search", JSON.stringify({ terms: "foo" }));
    expect(reg.getRepairStats()).toEqual({
      search: { "bare-string-wrapped": 1 },
    });
    reg.resetRepairStats();
    expect(reg.getRepairStats()).toEqual({});
  });

  it("jsonrepair fallback rescues single-quoted args", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", "{'path': 'a.ts', 'content': 'x'}");
    expect(result).toBe('ok:{"path":"a.ts","content":"x"}');
    expect(reg.getRepairStats()).toEqual({
      write_file: { "jsonrepair-fallback": 1 },
    });
  });

  it("jsonrepair fallback rescues trailing-comma args", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", '{"path":"a.ts","content":"x",}');
    expect(result).toBe('ok:{"path":"a.ts","content":"x"}');
    expect(reg.getRepairStats()).toEqual({
      write_file: { "jsonrepair-fallback": 1 },
    });
  });

  it("jsonrepair fallback strips fenced ```json``` wrapper", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", '```json\n{"path":"a.ts","content":"x"}\n```');
    expect(result).toBe('ok:{"path":"a.ts","content":"x"}');
    expect(reg.getRepairStats()).toEqual({
      write_file: { "jsonrepair-fallback": 1 },
    });
  });

  it("jsonrepair fallback refuses bare-string args (not a tool args object)", async () => {
    const reg = makeReg();
    const result = await reg.dispatch("write_file", "just some text");
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toMatch(/invalid tool arguments JSON/);
  });
});

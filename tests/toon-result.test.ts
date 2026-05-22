import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToonMode } from "../src/config.js";
import { flattenMcpResult } from "../src/mcp/registry.js";
import type { CallToolResult } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";
import { decodeToolResultObject } from "../src/toon/decode-result.js";
import { serializeToolResult } from "../src/toon/encode-result.js";
import { getToonStats, resetToonStats } from "../src/toon/stats.js";

describe("TOON tool-result payloads", () => {
  const originalToonEnv = process.env.REASONIX_TOON;

  beforeEach(() => {
    resetToonStats();
    // biome-ignore lint/performance/noDelete: the string "undefined" leaks into process.env otherwise
    delete process.env.REASONIX_TOON;
  });

  afterEach(() => {
    if (originalToonEnv === undefined) {
      // biome-ignore lint/performance/noDelete: restore exact env state
      delete process.env.REASONIX_TOON;
    } else {
      process.env.REASONIX_TOON = originalToonEnv;
    }
  });

  it("defaults to TOON while keeping explicit kill-switch modes byte-compatible with JSON", () => {
    const value = { error: "boom", rejectedReason: "plan-mode" };

    expect(resolveToonMode(undefined, undefined)).toBe("all");
    expect(resolveToonMode(false, undefined)).toBe("off");
    expect(resolveToonMode({ enabled: false }, undefined)).toBe("off");
    expect(resolveToonMode({ mode: "prefix" }, undefined)).toBe("prefix");
    expect(resolveToonMode(true, "0")).toBe("off");
    expect(serializeToolResult(value)).toContain("rejectedReason: plan-mode");
    expect(serializeToolResult(value, { mode: "off" })).toBe(JSON.stringify(value));
    expect(serializeToolResult(JSON.stringify(value), { mode: "off" })).toBe(JSON.stringify(value));
  });

  it("encodes structured values and decodes them without losing control fields", () => {
    const encoded = serializeToolResult(
      {
        rows: [
          { id: 1, name: "alpha" },
          { id: 2, name: "beta" },
        ],
        rejectedReason: "plan-mode",
      },
      { mode: "results" },
    );

    expect(encoded).toContain("rows[2]{id,name}:");
    expect(decodeToolResultObject(encoded)).toEqual({
      rows: [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ],
      rejectedReason: "plan-mode",
    });
  });

  it("re-encodes JSON-looking string results at the producer boundary", () => {
    const encoded = serializeToolResult(
      JSON.stringify({ success: true, output: "subagent body" }),
      { mode: "results" },
    );

    expect(encoded).toBe("success: true\noutput: subagent body");
    expect(decodeToolResultObject(encoded)).toEqual({
      success: true,
      output: "subagent body",
    });
  });

  it("emits TOON control signals from ToolRegistry without breaking repeat-gate decode", async () => {
    const registry = new ToolRegistry({ toonMode: "results" });
    registry.register({ name: "write_file", fn: () => "ok" });
    registry.addToolInterceptor("test-gate", () =>
      JSON.stringify({ error: "blocked", rejectedReason: "plan-mode" }),
    );

    const first = await registry.dispatch("write_file", { path: "x.ts" });
    const second = await registry.dispatch("write_file", { path: "x.ts" });

    expect(first).toContain("rejectedReason: plan-mode");
    expect(first.trimStart().startsWith("{")).toBe(false);
    expect(decodeToolResultObject(first)?.rejectedReason).toBe("plan-mode");
    expect(decodeToolResultObject(second)).toMatchObject({
      rejectedReason: "plan-mode",
      consecutiveInterceptorRejection: true,
    });
  });

  it("re-encodes JSON text blocks at the MCP flatten boundary", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ rows: [{ id: 1 }, { id: 2 }] }),
        },
      ],
    } satisfies CallToolResult;

    const flattened = flattenMcpResult(result, { toonMode: "results" });

    expect(flattened).toContain("rows[2]{id}:");
    expect(decodeToolResultObject(flattened)).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
  });

  it("keeps empty structured payloads decodable", () => {
    const encoded = serializeToolResult({}, { mode: "results" });

    expect(encoded).toBe("{}");
    expect(decodeToolResultObject(encoded)).toEqual({});
  });

  it("records encode and decode telemetry for result payloads", () => {
    const encoded = serializeToolResult(
      {
        rows: [
          { id: 1, value: "alpha" },
          { id: 2, value: "beta" },
          { id: 3, value: "gamma" },
        ],
      },
      { mode: "results" },
    );

    expect(decodeToolResultObject(encoded)).toEqual({
      rows: [
        { id: 1, value: "alpha" },
        { id: 2, value: "beta" },
        { id: 3, value: "gamma" },
      ],
    });
    expect(decodeToolResultObject(JSON.stringify({ ok: true }))).toEqual({ ok: true });

    const stats = getToonStats();
    expect(stats.layers["tool-result"].hits).toBe(1);
    expect(stats.layers["tool-result"].jsonTokens).toBeGreaterThan(0);
    expect(stats.layers["tool-result"].toonTokens).toBeGreaterThan(0);
    expect(stats.decode.toon).toBe(1);
    expect(stats.decode.json).toBe(1);
    expect(stats.fallbacks.encode).toBe(0);
    expect(stats.fallbacks.decode).toBe(0);
  });
});

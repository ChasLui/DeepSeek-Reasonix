/** Regression test for issue #1295 — React #31 when config.json mcp array contains non-string items */

import { describe, expect, it } from "vitest";
import { summarizeMcpSpec } from "../src/cli/commands/desktop.js";

describe("summarizeMcpSpec — normal string inputs", () => {
  it("returns stdio summary for a valid stdio spec", () => {
    const result = summarizeMcpSpec("fs=npx -y @modelcontextprotocol/server-filesystem /tmp");
    expect(result.transport).toBe("stdio");
    expect(result.summary).toBe("stdio · npx -y @modelcontextprotocol/server-filesystem /tmp");
    expect(result.status).toBe("configured");
    expect(result.name).toBe("fs");
    expect(result.raw).toBe("fs=npx -y @modelcontextprotocol/server-filesystem /tmp");
  });

  it("returns sse summary for a valid sse spec", () => {
    const result = summarizeMcpSpec("local=https://127.0.0.1:9000/sse");
    expect(result.transport).toBe("sse");
    expect(result.summary).toBe("sse · https://127.0.0.1:9000/sse");
    expect(result.status).toBe("configured");
    expect(result.name).toBe("local");
  });

  it("returns streamable-http summary for a valid streamable-http spec", () => {
    const result = summarizeMcpSpec("remote=streamable+https://example.com/mcp");
    expect(result.transport).toBe("streamable-http");
    expect(result.summary).toBe("streamable-http · https://example.com/mcp");
    expect(result.status).toBe("configured");
  });
});

describe("summarizeMcpSpec — malformed / non-string inputs (defensive)", () => {
  it("stringifies an object input in the catch block instead of returning it raw", () => {
    const badInput = {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y"],
    } as unknown as string;
    const result = summarizeMcpSpec(badInput);
    expect(typeof result.summary).toBe("string");
    expect(result.summary).not.toEqual(badInput);
    expect(result.summary).toContain("github");
    expect(result.status).toBe("failed");
    expect(result.name).toBeNull();
    expect(result.parseError).toBeTruthy();
  });

  it("stringifies an array input in the catch block", () => {
    const badInput = ["npx", "-y", "pkg"] as unknown as string;
    const result = summarizeMcpSpec(badInput);
    expect(typeof result.summary).toBe("string");
    expect(result.status).toBe("failed");
    expect(result.name).toBeNull();
  });

  it("handles null input gracefully", () => {
    const result = summarizeMcpSpec(null as unknown as string);
    expect(typeof result.summary).toBe("string");
    expect(result.summary).toBe("null");
    expect(result.status).toBe("failed");
    expect(result.name).toBeNull();
  });

  it("handles undefined input gracefully", () => {
    const result = summarizeMcpSpec(undefined as unknown as string);
    expect(typeof result.summary).toBe("string");
    expect(result.status).toBe("failed");
    expect(result.name).toBeNull();
  });

  it("handles number input gracefully", () => {
    const result = summarizeMcpSpec(42 as unknown as string);
    expect(typeof result.summary).toBe("string");
    expect(result.summary).toBe("42");
    expect(result.status).toBe("failed");
  });

  it("preserves the raw string for invalid spec text", () => {
    const badSpec = "   ";
    const result = summarizeMcpSpec(badSpec);
    expect(result.raw).toBe(badSpec);
    expect(typeof result.summary).toBe("string");
    expect(result.summary).toBe(badSpec);
    expect(result.status).toBe("failed");
  });
});

describe("summarizeMcpSpec — summary is always a string (React #31 invariant)", () => {
  it("never returns an object summary for any input", () => {
    const inputs: unknown[] = [
      "valid=npx pkg",
      "",
      "   ",
      { foo: "bar" },
      [1, 2, 3],
      null,
      undefined,
      42,
      true,
    ];
    for (const input of inputs) {
      const result = summarizeMcpSpec(input as string);
      expect(typeof result.summary).toBe("string");
      expect(result.summary === null || typeof result.summary === "object").toBe(false);
    }
  });
});

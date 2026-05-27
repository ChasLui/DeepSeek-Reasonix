import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpToolCache, saveMcpToolCache } from "../src/mcp/cache.js";
import type { McpClient } from "../src/mcp/client.js";
import type { StdioMcpSpec } from "../src/mcp/spec.js";

const tool = { name: "a", description: "A", inputSchema: { type: "object" } };

function client(overrides: Partial<McpClient> = {}): McpClient {
  return {
    serverInfo: { name: "server", version: "1.0.0" },
    protocolVersion: "2024-11-05",
    serverCapabilities: { tools: { listChanged: true } },
    ...overrides,
  } as McpClient;
}

function spec(env: Record<string, string> = { TOKEN: "secret" }): StdioMcpSpec & {
  env: Record<string, string>;
} {
  return { transport: "stdio", name: "serena", command: "serena", args: ["mcp"], env };
}

describe("MCP tools/list schema cache", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.REASONIX_HOME;
    home = mkdtempSync(join(tmpdir(), "reasonix-cache-test-"));
    process.env.REASONIX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, "REASONIX_HOME");
    else process.env.REASONIX_HOME = previousHome;
  });

  it("saves and loads a verified cache hit without env-derived filename data", () => {
    saveMcpToolCache("serena", spec(), client(), [tool]);

    expect(loadMcpToolCache("serena", spec(), client())).toEqual([tool]);
    expect(readdirSync(join(home, "mcp-cache"))).toEqual(["serena.json"]);
    expect(statSync(join(home, "mcp-cache")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "mcp-cache", "serena.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".cache-salt")).mode & 0o777).toBe(0o600);
  });

  it("misses when env changes because the internal salted specHash changes", () => {
    saveMcpToolCache("serena", spec({ TOKEN: "one" }), client(), [tool]);

    expect(loadMcpToolCache("serena", spec({ TOKEN: "two" }), client())).toBeNull();
  });

  it("misses when server metadata or capability digest changes before exposing cached tools", () => {
    saveMcpToolCache("serena", spec(), client(), [tool]);

    expect(
      loadMcpToolCache(
        "serena",
        spec(),
        client({ serverCapabilities: { tools: { listChanged: false } } }),
      ),
    ).toBeNull();
    expect(
      loadMcpToolCache("serena", spec(), client({ serverInfo: { name: "server", version: "2" } })),
    ).toBeNull();
  });

  it("expires entries older than 24h", () => {
    saveMcpToolCache("serena", spec(), client(), [tool]);
    const path = join(home, "mcp-cache", "serena.json");
    const entry = JSON.parse(readFileSync(path, "utf8")) as { savedAt: number };
    writeFileSync(path, `${JSON.stringify({ ...entry, savedAt: 0 })}\n`, { mode: 0o600 });

    expect(loadMcpToolCache("serena", spec(), client())).toBeNull();
  });
});

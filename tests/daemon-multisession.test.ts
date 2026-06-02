/** McpPool — one warm child per workspace, bridged into each session's own registry (FR-005/NF-004/FR-006). */

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const initializeMock = vi.fn(async () => undefined);
  const closeMock = vi.fn(async () => undefined);
  const bridgeMock = vi.fn(async (_client: unknown, opts: { namePrefix?: string }) => ({
    registeredNames: [`${opts.namePrefix ?? ""}echo`],
  }));
  class FakeMcpClient {
    async initialize() {
      return initializeMock();
    }
    async close() {
      return closeMock();
    }
  }
  class FakeTransport {}
  return {
    initializeMock,
    closeMock,
    bridgeMock,
    FakeMcpClient,
    FakeTransport,
  };
});

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    readConfig: () => ({ mcpDisabled: [] }),
    mcpEnvFor: () => ({}),
  };
});
vi.mock("../src/mcp/client.js", () => ({ McpClient: mocks.FakeMcpClient }));
vi.mock("../src/mcp/registry.js", () => ({ bridgeMcpTools: mocks.bridgeMock }));
vi.mock("../src/mcp/preflight.js", () => ({
  preflightStdioSpec: () => undefined,
}));
vi.mock("../src/mcp/transport-from-spec.js", () => ({
  buildTransportFromSpec: () => new mocks.FakeTransport(),
}));
vi.mock("../src/tools/tiering.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/tiering.js")>();
  return {
    ...actual,
    applyMcpServerTier: () => undefined,
    resolveMcpDefaultTier: () => 0,
  };
});

async function makePool() {
  vi.resetModules();
  const { McpPool } = await import("../src/daemon/mcp-pool.js");
  const { ToolRegistry } = await import("../src/tools.js");
  return { pool: new McpPool(), ToolRegistry };
}

describe("McpPool — warm per-workspace sharing", () => {
  afterEach(() => {
    mocks.initializeMock.mockClear();
    mocks.closeMock.mockClear();
    mocks.bridgeMock.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("initializes the child once per workspace but bridges per session", async () => {
    const { pool, ToolRegistry } = await makePool();
    await pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry());
    await pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry());
    // Two sessions in one workspace: one handshake (NF-004), two bridges (FR-005).
    expect(mocks.initializeMock).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeMock).toHaveBeenCalledTimes(2);
  });

  it("spawns a separate child for a different workspace", async () => {
    const { pool, ToolRegistry } = await makePool();
    await pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry());
    await pool.bridgeInto("/ws/b", ["fs=cmd a"], undefined, new ToolRegistry());
    expect(mocks.initializeMock).toHaveBeenCalledTimes(2);
    expect(pool.workspaceCount).toBe(2);
  });

  it("concurrent first-sessions in one workspace share a single handshake", async () => {
    const { pool, ToolRegistry } = await makePool();
    await Promise.all([
      pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry()),
      pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry()),
    ]);
    expect(mocks.initializeMock).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeMock).toHaveBeenCalledTimes(2);
  });

  it("closeAll tears down every workspace's children", async () => {
    const { pool, ToolRegistry } = await makePool();
    await pool.bridgeInto("/ws/a", ["fs=cmd a"], undefined, new ToolRegistry());
    await pool.bridgeInto("/ws/b", ["fs=cmd a"], undefined, new ToolRegistry());
    await pool.closeAll();
    expect(mocks.closeMock).toHaveBeenCalledTimes(2);
    expect(pool.workspaceCount).toBe(0);
  });
});

describe("McpPool — prefix parity with the per-session loader (NF-005)", () => {
  afterEach(() => {
    mocks.bridgeMock.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  // The pooled path must register each MCP server's tools with the SAME
  // (namePrefix, serverName, tier) as the in-process loadMcpServers, so the
  // session's filteredSpecs — and thus its immutable prefix bytes — are
  // identical regardless of pooling (Pillar 1 cache-hit accounting).
  it("bridges each spec with the same prefix/serverName/tier as loadMcpServers", async () => {
    vi.resetModules();
    const { loadMcpServers } = await import("../src/cli/commands/acp.js");
    const { McpPool } = await import("../src/daemon/mcp-pool.js");
    const { ToolRegistry } = await import("../src/tools.js");
    const specs = ["fs=cmd a", "db=cmd b"];

    const bridgeArgs = () =>
      mocks.bridgeMock.mock.calls.map(([, o]) => {
        const opts = o as {
          namePrefix?: string;
          serverName?: string;
          mcpDefaultTier?: number;
        };
        return {
          namePrefix: opts.namePrefix,
          serverName: opts.serverName,
          mcpDefaultTier: opts.mcpDefaultTier,
        };
      });

    await loadMcpServers(new ToolRegistry(), specs, undefined);
    const loaderCalls = bridgeArgs();

    mocks.bridgeMock.mockClear();
    await new McpPool().bridgeInto("/ws", specs, undefined, new ToolRegistry());
    const poolCalls = bridgeArgs();

    expect(poolCalls).toEqual(loaderCalls);
    expect(poolCalls).toEqual([
      { namePrefix: "fs_", serverName: "fs", mcpDefaultTier: 0 },
      { namePrefix: "db_", serverName: "db", mcpDefaultTier: 0 },
    ]);
  });
});

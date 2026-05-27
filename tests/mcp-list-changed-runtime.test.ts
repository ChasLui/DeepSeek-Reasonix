import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTool } from "../src/mcp/types.js";

const mocks = vi.hoisted(() => {
  class FakeMcpClient {
    static instances: FakeMcpClient[] = [];
    protocolVersion = "2024-11-05";
    serverInfo = { name: "fake", version: "1.0.0" };
    serverCapabilities = { tools: { listChanged: true } };
    tools: McpTool[] = [{ name: "a", inputSchema: { type: "object", properties: {} } }];
    failCalls = false;
    private toolsListChanged: Array<() => void | Promise<void>> = [];

    constructor() {
      FakeMcpClient.instances.push(this);
    }
    async initialize() {}
    async close() {}
    async listTools() {
      return { tools: this.tools };
    }
    async callTool() {
      if (this.failCalls) throw new Error("MCP request tools/call timed out after 1ms");
      return { content: [{ type: "text" as const, text: "ok" }] };
    }
    onToolsListChanged(cb: () => void | Promise<void>) {
      this.toolsListChanged.push(cb);
      return () => {
        this.toolsListChanged = this.toolsListChanged.filter((item) => item !== cb);
      };
    }
    onResourcesListChanged() {
      return () => undefined;
    }
    onPromptsListChanged() {
      return () => undefined;
    }
    emitToolsListChanged() {
      for (const cb of this.toolsListChanged) void cb();
    }
  }
  return { FakeMcpClient };
});

vi.mock("../src/mcp/client.js", () => ({ McpClient: mocks.FakeMcpClient }));
vi.mock("../src/mcp/preflight.js", () => ({ preflightStdioSpec: vi.fn() }));
vi.mock("../src/mcp/transport-from-spec.js", () => ({ buildTransportFromSpec: vi.fn(() => ({})) }));
vi.mock("../src/mcp/inspect.js", () => ({
  inspectMcpServer: vi.fn(async () => ({
    protocolVersion: "2024-11-05",
    serverInfo: { name: "fake", version: "1.0.0" },
    capabilities: { tools: { listChanged: true } },
    tools: { supported: true, items: [] },
    resources: { supported: false, reason: "none" },
    prompts: { supported: false, reason: "none" },
    elapsedMs: 1,
  })),
}));

describe("createMcpRuntime listChanged handling", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.REASONIX_HOME;
    process.env.REASONIX_HOME = mkdtempSync(join(tmpdir(), "reasonix-list-changed-"));
    mocks.FakeMcpClient.instances.length = 0;
  });

  afterEach(() => {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, "REASONIX_HOME");
    else process.env.REASONIX_HOME = previousHome;
    vi.restoreAllMocks();
  });

  it("hot-adds append drift through prefix.addTool and updates the next baseline", async () => {
    const [{ createMcpRuntime }, { ToolRegistry }] = await Promise.all([
      import("../src/cli/commands/mcp-runtime.js"),
      import("../src/tools.js"),
    ]);
    const registry = new ToolRegistry();
    const added: string[] = [];
    const loop = {
      prefix: {
        addTool: (spec: { function: { name: string } }) => added.push(spec.function.name),
        removeTool: vi.fn(),
      },
    };
    const runtime = createMcpRuntime({
      getTools: () => registry,
      getMcpPrefix: () => undefined,
      getRequestedCount: () => 1,
      progressSink: { current: null },
      projectRoot: () => process.cwd(),
    });

    await runtime.addSpec("srv=cmd", loop as never);
    const client = mocks.FakeMcpClient.instances[0]!;
    client.tools = [
      { name: "a", inputSchema: { type: "object", properties: {} } },
      { name: "b", inputSchema: { type: "object", properties: {} } },
    ];
    client.emitToolsListChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.tools = [
      { name: "a", inputSchema: { type: "object", properties: {} } },
      { name: "b", inputSchema: { type: "object", properties: {} } },
      { name: "c", inputSchema: { type: "object", properties: {} } },
    ];
    client.emitToolsListChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toEqual(["srv_a", "srv_b", "srv_c"]);
    expect(registry.has("srv_b")).toBe(true);
    expect(registry.has("srv_c")).toBe(true);
  });

  it("refilter removes and re-adds MCP tools through prefix mutations", async () => {
    const [{ createMcpRuntime }, { ToolRegistry }] = await Promise.all([
      import("../src/cli/commands/mcp-runtime.js"),
      import("../src/tools.js"),
    ]);
    const registry = new ToolRegistry();
    let selection: ReadonlySet<string> | null = new Set(["srv_a"]);
    const added: string[] = [];
    const removed: string[] = [];
    const loop = {
      prefix: {
        addTool: (spec: { function: { name: string } }) => added.push(spec.function.name),
        removeTool: (name: string) => removed.push(name),
      },
    };
    const runtime = createMcpRuntime({
      getTools: () => registry,
      getMcpPrefix: () => undefined,
      getRequestedCount: () => 1,
      progressSink: { current: null },
      projectRoot: () => process.cwd(),
      getToolSelection: () => selection,
    });

    await runtime.addSpec("srv=cmd", loop as never);
    selection = new Set();
    expect(await runtime.refilter(loop as never)).toEqual({ added: [], removed: ["srv_a"] });
    selection = new Set(["srv_a"]);
    expect(await runtime.refilter(loop as never)).toEqual({ added: ["srv_a"], removed: [] });

    expect(added).toEqual(["srv_a", "srv_a"]);
    expect(removed).toEqual(["srv_a"]);
  });

  it("starts self-heal reconnect after repeated unhealthy tool calls", async () => {
    const [{ createMcpRuntime }, { ToolRegistry }] = await Promise.all([
      import("../src/cli/commands/mcp-runtime.js"),
      import("../src/tools.js"),
    ]);
    const registry = new ToolRegistry();
    const loop = { prefix: { addTool: vi.fn(), removeTool: vi.fn() } };
    const runtime = createMcpRuntime({
      getTools: () => registry,
      getMcpPrefix: () => undefined,
      getRequestedCount: () => 1,
      progressSink: { current: null },
      projectRoot: () => process.cwd(),
    });

    await runtime.addSpec("srv=cmd", loop as never);
    const client = mocks.FakeMcpClient.instances[0]!;
    client.failCalls = true;
    for (let i = 0; i < 3; i++) {
      const out = await registry.dispatch("srv_a", "{}");
      expect(out).toContain("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 2; i++) await registry.dispatch("srv_a", "{}");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.FakeMcpClient.instances.length).toBeGreaterThanOrEqual(2);
  });
});

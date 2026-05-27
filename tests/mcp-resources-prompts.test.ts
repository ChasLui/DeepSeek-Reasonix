import { describe, expect, it } from "vitest";
import type { McpClient } from "../src/mcp/client.js";
import { bridgeMcpPrompts, bridgeMcpResources } from "../src/mcp/registry.js";
import { ToolRegistry } from "../src/tools.js";

function fakeClient(overrides: Partial<McpClient>): McpClient {
  return {
    serverCapabilities: {},
    serverInfo: { name: "srv", version: "1.0.0" },
    ...overrides,
  } as McpClient;
}

describe("bridgeMcpResources", () => {
  it("does not register resource tools when resources capability is absent", async () => {
    const registry = new ToolRegistry();
    const result = await bridgeMcpResources(fakeClient({}), { registry, serverName: "srv" });

    expect(result.registeredNames).toEqual([]);
    expect(registry.has("mcp__srv__list_resources")).toBe(false);
  });

  it("requires read_resource URIs to come from this session's list_resources result", async () => {
    const registry = new ToolRegistry();
    await bridgeMcpResources(
      fakeClient({
        serverCapabilities: { resources: {} },
        listResources: async () => ({ resources: [{ uri: "file:///a.md", name: "a" }] }),
        readResource: async () => ({ contents: [{ uri: "file:///a.md", text: "ok" }] }),
      }),
      { registry, serverName: "srv" },
    );

    await expect(
      registry.get("mcp__srv__read_resource")!.fn({ uri: "file:///a.md" }),
    ).rejects.toThrow(/list_resources/);
    await registry.get("mcp__srv__list_resources")!.fn({});

    await expect(
      registry.get("mcp__srv__read_resource")!.fn({ uri: "file:///a.md" }),
    ).resolves.toBe("ok");
  });

  it("blocks denied URI schemes even when a server listed them", async () => {
    const registry = new ToolRegistry();
    await bridgeMcpResources(
      fakeClient({
        serverCapabilities: { resources: {} },
        listResources: async () => ({ resources: [{ uri: "data:text/plain,hi", name: "bad" }] }),
        readResource: async () => ({ contents: [{ uri: "data:text/plain,hi", text: "bad" }] }),
      }),
      { registry, serverName: "srv" },
    );
    await registry.get("mcp__srv__list_resources")!.fn({});

    await expect(
      registry.get("mcp__srv__read_resource")!.fn({ uri: "data:text/plain,hi" }),
    ).rejects.toThrow(/blocked URI scheme/);
  });

  it("returns binary resource placeholders instead of model-visible blobs", async () => {
    const registry = new ToolRegistry();
    await bridgeMcpResources(
      fakeClient({
        serverCapabilities: { resources: {} },
        listResources: async () => ({ resources: [{ uri: "file:///bin", name: "bin" }] }),
        readResource: async () => ({
          contents: [
            { uri: "file:///bin", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
          ],
        }),
      }),
      { registry, serverName: "srv" },
    );
    await registry.get("mcp__srv__list_resources")!.fn({});

    await expect(registry.get("mcp__srv__read_resource")!.fn({ uri: "file:///bin" })).resolves.toBe(
      "[binary resource file:///bin, application/octet-stream, 5 bytes]",
    );
  });

  it("allows server-declared resource templates after list_resources", async () => {
    const registry = new ToolRegistry();
    await bridgeMcpResources(
      fakeClient({
        serverCapabilities: { resources: {} },
        listResources: async () =>
          ({
            resources: [],
            resourceTemplates: [{ uriTemplate: "file:///docs/{name}.md" }],
          }) as never,
        readResource: async () => ({
          contents: [{ uri: "file:///docs/a.md", text: "templated" }],
        }),
      }),
      { registry, serverName: "srv" },
    );
    await registry.get("mcp__srv__list_resources")!.fn({});

    await expect(
      registry.get("mcp__srv__read_resource")!.fn({ uri: "file:///docs/a.md" }),
    ).resolves.toBe("templated");
  });
});

describe("bridgeMcpPrompts", () => {
  it("registers prompt tools behind prompt capability and sanitizes binary resource blocks", async () => {
    const registry = new ToolRegistry();
    await bridgeMcpPrompts(
      fakeClient({
        serverCapabilities: { prompts: {} },
        listPrompts: async () => ({ prompts: [{ name: "summarize" }] }),
        getPrompt: async () => ({
          messages: [
            {
              role: "user",
              content: {
                type: "resource",
                resource: {
                  uri: "file:///bin",
                  mimeType: "application/octet-stream",
                  blob: "aGk=",
                },
              },
            },
          ],
        }),
      }),
      { registry, serverName: "srv" },
    );

    const raw = await registry.get("mcp__srv__get_prompt")!.fn({ name: "summarize" });
    expect(String(raw)).toContain(
      "[binary resource file:///bin, application/octet-stream, 2 bytes]",
    );
  });
});

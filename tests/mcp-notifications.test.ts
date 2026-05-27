import { describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp/types.js";

class NotificationTransport implements McpTransport {
  private readonly queue: JsonRpcMessage[] = [];
  private readonly waiters: Array<(msg: JsonRpcMessage | null) => void> = [];
  private closed = false;

  constructor(private readonly capabilities: Record<string, unknown>) {}

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!("method" in msg) || !("id" in msg)) return;
    const req = msg as JsonRpcRequest;
    if (req.method !== "initialize") return;
    this.emit({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "notify", version: "1.0.0" },
        capabilities: this.capabilities,
      },
    });
  }

  async *messages(): AsyncIterableIterator<JsonRpcMessage> {
    while (!this.closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      const next = await new Promise<JsonRpcMessage | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }

  emit(msg: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }
}

describe("McpClient listChanged notifications", () => {
  it("routes tools/list_changed only when the server advertised it", async () => {
    const transport = new NotificationTransport({ tools: { listChanged: true } });
    const client = new McpClient({ transport });
    const onTools = vi.fn();
    client.onToolsListChanged(onTools);
    await client.initialize();

    transport.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTools).toHaveBeenCalledTimes(1);
    expect(client.notificationDropCount("mcp.notification.dropped.no_capability")).toBe(0);
    await client.close();
  });

  it("drops list_changed notifications without capability and records the debug metric", async () => {
    const transport = new NotificationTransport({ tools: { listChanged: false } });
    const client = new McpClient({ transport });
    const onTools = vi.fn();
    client.onToolsListChanged(onTools);
    await client.initialize();

    transport.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTools).not.toHaveBeenCalled();
    expect(client.notificationDropCount("mcp.notification.dropped.no_capability")).toBe(1);
    await client.close();
  });

  it("routes resources and prompts listChanged through their own capability gates", async () => {
    const transport = new NotificationTransport({
      tools: {},
      resources: { listChanged: true },
      prompts: { listChanged: true },
    });
    const client = new McpClient({ transport });
    const onResources = vi.fn();
    const onPrompts = vi.fn();
    client.onResourcesListChanged(onResources);
    client.onPromptsListChanged(onPrompts);
    await client.initialize();

    transport.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    transport.emit({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onResources).toHaveBeenCalledTimes(1);
    expect(onPrompts).toHaveBeenCalledTimes(1);
    await client.close();
  });
});

/** DaemonHost — JSON-RPC session protocol over an in-memory AcpServer pair, with a stubbed loop. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpServer } from "../src/acp/server.js";
import type { Session } from "../src/cli/commands/acp.js";
import { connectDaemon } from "../src/daemon/client.js";
import { DaemonHost } from "../src/daemon/host.js";
import { listenDaemon } from "../src/daemon/server-listen.js";
import type { LoopEvent } from "../src/loop/types.js";

function makeHostPair(events: LoopEvent[]): {
  send: (msg: unknown) => void;
  lines: () => unknown[];
  close: () => void;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const collected: unknown[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) collected.push(JSON.parse(trimmed));
    }
  });
  const server = new AcpServer({ input, output });
  const host = new DaemonHost({
    defaultDir: "/tmp",
    createSession: async (rootDir): Promise<Session> =>
      ({
        id: "sess_test",
        rootDir,
        model: "test",
        mcpClients: [],
        aborter: null,
        loop: {
          async *step(): AsyncGenerator<LoopEvent> {
            for (const ev of events) yield ev;
          },
        },
      }) as unknown as Session,
  });
  host.attach(server);
  return {
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    lines: () => collected.slice(),
    close: () => server.close(),
  };
}

function wait(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseFor(
  lines: unknown[],
  id: number,
): { result?: unknown; error?: unknown } | undefined {
  return lines.find((l) => (l as { id?: number }).id === id) as
    | { result?: unknown; error?: unknown }
    | undefined;
}

describe("DaemonHost — session protocol", () => {
  it("initialize advertises reasonix agent capabilities", async () => {
    const h = makeHostPair([]);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    await wait();
    const reply = responseFor(h.lines(), 1) as {
      result?: { agentInfo?: { name?: string } };
    };
    expect(reply?.result?.agentInfo?.name).toBe("reasonix");
    h.close();
  });

  it("ping reports the process pid and active session count", async () => {
    const h = makeHostPair([]);
    h.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    await wait();
    const reply = responseFor(h.lines(), 1) as {
      result?: { pid?: number; sessions?: number };
    };
    expect(reply?.result?.pid).toBe(process.pid);
    expect(reply?.result?.sessions).toBe(0);
    h.close();
  });

  it("session/new then session/prompt streams loop events and ends the turn", async () => {
    const events: LoopEvent[] = [
      { turn: 1, role: "assistant_delta", content: "hello " },
      { turn: 1, role: "assistant_delta", content: "world" },
      { turn: 1, role: "done", content: "" },
    ];
    const h = makeHostPair(events);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp" },
    });
    await wait();
    const created = responseFor(h.lines(), 1) as {
      result?: { sessionId?: string };
    };
    const sessionId = created?.result?.sessionId;
    expect(sessionId).toBe("sess_test");

    h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
    });
    await wait();

    const loopEvents = h
      .lines()
      .filter((l) => (l as { method?: string }).method === "session/loopEvent")
      .map((l) => (l as { params: { event: LoopEvent } }).params.event);
    expect(loopEvents.map((e) => e.role)).toEqual(["assistant_delta", "assistant_delta", "done"]);

    const prompt = responseFor(h.lines(), 2) as {
      result?: { stopReason?: string };
    };
    expect(prompt?.result?.stopReason).toBe("end_turn");
    h.close();
  });

  it("session/prompt on an unknown session returns an error", async () => {
    const h = makeHostPair([]);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] },
    });
    await wait();
    const reply = responseFor(h.lines(), 1) as { error?: { message?: string } };
    expect(reply?.error?.message).toContain("unknown session");
    h.close();
  });
});

describe("DaemonHost — real socket transport", () => {
  it.skipIf(process.platform === "win32")("serves ping over a unix domain socket", async () => {
    const sock = join(tmpdir(), `reasonix-daemon-test-${process.pid}-${Date.now()}.sock`);
    const host = new DaemonHost({ defaultDir: "/tmp" });
    const server = await listenDaemon(host, sock);
    const client = await connectDaemon(sock);
    try {
      await client.initialize();
      const pong = await client.ping();
      expect(pong.pid).toBe(process.pid);
      expect(pong.sessions).toBe(0);
    } finally {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

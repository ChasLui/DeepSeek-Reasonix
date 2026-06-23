/** DaemonHost — JSON-RPC session protocol over an in-memory AcpServer pair, with a stubbed loop. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpServer } from "../src/acp/server.js";
import type { Session } from "../src/cli/commands/acp.js";
import { Eventizer } from "../src/core/eventize.js";
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
    defaultDir: tmpdir(),
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

async function eventually<T>(read: () => T | undefined, timeoutMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await wait();
    value = read();
  }
  expect(value).not.toBeUndefined();
  return value as T;
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
    const reply = await eventually(
      () =>
        responseFor(h.lines(), 1) as
          | {
              result?: { agentInfo?: { name?: string } };
            }
          | undefined,
    );
    expect(reply?.result?.agentInfo?.name).toBe("reasonix");
    h.close();
  });

  it("ping reports the process pid and active session count", async () => {
    const h = makeHostPair([]);
    h.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    const reply = await eventually(
      () =>
        responseFor(h.lines(), 1) as
          | {
              result?: { pid?: number; sessions?: number };
            }
          | undefined,
    );
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
      params: { cwd: tmpdir() },
    });
    const created = await eventually(
      () =>
        responseFor(h.lines(), 1) as
          | {
              result?: { sessionId?: string };
            }
          | undefined,
    );
    const sessionId = created?.result?.sessionId;
    expect(sessionId).toBe("sess_test");

    h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
    });
    await eventually(() => responseFor(h.lines(), 2));

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
    const reply = await eventually(
      () => responseFor(h.lines(), 1) as { error?: { message?: string } } | undefined,
    );
    expect(reply?.error?.message).toContain("unknown session");
    h.close();
  });
});

describe("DaemonHost — concurrent sessions", () => {
  it("routes each session's events to its own sessionId", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) collected.push(JSON.parse(line.trim()));
      }
    });
    const server = new AcpServer({ input, output });
    let n = 0;
    const host = new DaemonHost({
      defaultDir: tmpdir(),
      createSession: async (rootDir): Promise<Session> => {
        const id = `sess_${++n}`;
        return {
          id,
          rootDir,
          mcpClients: [],
          aborter: null,
          loop: {
            async *step(): AsyncGenerator<LoopEvent> {
              yield { turn: 1, role: "assistant_delta", content: id };
              yield { turn: 1, role: "done", content: "" };
            },
          },
        } as unknown as Session;
      },
    });
    host.attach(server);
    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: tmpdir() },
    });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpdir() },
    });
    await Promise.all([1, 2].map((i) => eventually(() => responseFor(collected, i))));
    const ids = [1, 2]
      .map((i) => responseFor(collected, i) as { result?: { sessionId?: string } })
      .map((r) => r?.result?.sessionId);
    expect(new Set(ids).size).toBe(2);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: ids[0], prompt: [{ type: "text", text: "a" }] },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId: ids[1], prompt: [{ type: "text", text: "b" }] },
    });
    await eventually(() => {
      const deltas = collected.filter(
        (l) =>
          (l as { method?: string }).method === "session/loopEvent" &&
          (l as { params: { event: LoopEvent } }).params.event.role === "assistant_delta",
      );
      return deltas.length >= 2 ? deltas : undefined;
    });

    const deltas = collected
      .filter(
        (l) =>
          (l as { method?: string }).method === "session/loopEvent" &&
          (l as { params: { event: LoopEvent } }).params.event.role === "assistant_delta",
      )
      .map((l) => (l as { params: { sessionId: string; event: LoopEvent } }).params);
    // Each session's delta carries its own id as content — no cross-talk.
    for (const d of deltas) expect(d.event.content).toBe(d.sessionId);
    expect(new Set(deltas.map((d) => d.sessionId))).toEqual(new Set(ids));
    server.close();
  });
});

describe("DaemonHost — kernel-event convergence", () => {
  it("emits session/update kernel events alongside raw loopEvents", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) collected.push(JSON.parse(line.trim()));
      }
    });
    const server = new AcpServer({ input, output });
    const host = new DaemonHost({
      defaultDir: tmpdir(),
      createSession: async (rootDir): Promise<Session> =>
        ({
          id: "sess_k",
          rootDir,
          mcpClients: [],
          aborter: null,
          eventizer: new Eventizer(),
          ctx: { model: "m", prefixHash: "h", reasoningEffort: "high" },
          loop: {
            async *step(): AsyncGenerator<LoopEvent> {
              yield { turn: 1, role: "assistant_delta", content: "hi there" };
              yield { turn: 1, role: "done", content: "" };
            },
          },
        }) as unknown as Session,
    });
    host.attach(server);
    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: tmpdir() },
    });
    await eventually(() => responseFor(collected, 1));
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_k", prompt: [{ type: "text", text: "x" }] },
    });
    await eventually(() =>
      collected.find((l) => (l as { method?: string }).method === "session/update"),
    );

    const updates = collected
      .filter((l) => (l as { method?: string }).method === "session/update")
      .map(
        (l) =>
          (
            l as {
              params: {
                update: { sessionUpdate: string; content?: { text?: string } };
              };
            }
          ).params.update,
      );
    const chunk = updates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk?.content?.text).toBe("hi there");
    server.close();
  });
});

describe("DaemonHost — real socket transport", () => {
  it.skipIf(process.platform === "win32")("serves ping over a unix domain socket", async () => {
    const sock = join(tmpdir(), `reasonix-daemon-test-${process.pid}-${Date.now()}.sock`);
    const host = new DaemonHost({ defaultDir: tmpdir() });
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

describe("DaemonHost — idle shutdown (Slice 5)", () => {
  it("fires onIdle after the idle window when no session ever connects", async () => {
    const onIdle = vi.fn();
    const host = new DaemonHost({ defaultDir: tmpdir(), idleMs: 25, onIdle });
    host.start();
    await wait(60);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await host.closeAll();
  });

  it("disarms while a session is active and re-arms after it detaches", async () => {
    const onIdle = vi.fn();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AcpServer({ input, output });
    const host = new DaemonHost({
      defaultDir: tmpdir(),
      idleMs: 25,
      onIdle,
      createSession: async (rootDir): Promise<Session> =>
        ({
          id: "s1",
          rootDir,
          mcpClients: [],
          aborter: null,
        }) as unknown as Session,
    });
    host.attach(server);
    host.start(); // armed (0 sessions)
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: tmpdir() } })}\n`,
    );
    await wait(40); // session active → idle disarmed, must NOT fire
    expect(onIdle).not.toHaveBeenCalled();

    await host.detach(server); // last session gone → re-arm
    await wait(40);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await host.closeAll();
  });
});

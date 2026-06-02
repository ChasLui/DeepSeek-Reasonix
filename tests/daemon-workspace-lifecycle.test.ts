/** WorkspaceLifecycle (Slice 0) — per-workspace refcount + busy/idle bookkeeping, and its DaemonHost wiring (session/new → open, detach → close, cancel keeps the session alive). */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpServer } from "../src/acp/server.js";
import type { Session } from "../src/cli/commands/acp.js";
import { DaemonHost } from "../src/daemon/host.js";
import { WorkspaceLifecycle } from "../src/daemon/workspace-lifecycle.js";

function wait(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WorkspaceLifecycle — refcount + closed", () => {
  it("emits closed only when a root's last session detaches", () => {
    const lc = new WorkspaceLifecycle();
    const closed: string[] = [];
    lc.onClosed((r) => closed.push(r));
    lc.onSessionOpen("/a");
    lc.onSessionOpen("/a");
    expect(lc.refcountOf("/a")).toBe(2);
    lc.onSessionClose("/a");
    expect(closed).toEqual([]); // still one session open
    expect(lc.refcountOf("/a")).toBe(1);
    lc.onSessionClose("/a");
    expect(closed).toEqual(["/a"]); // last session gone
    expect(lc.refcountOf("/a")).toBe(0);
    expect(lc.activeRoots()).toEqual([]);
  });

  it("keeps roots isolated — closing one doesn't affect another", () => {
    const lc = new WorkspaceLifecycle();
    const closed: string[] = [];
    lc.onClosed((r) => closed.push(r));
    lc.onSessionOpen("/a");
    lc.onSessionOpen("/b");
    lc.onSessionClose("/a");
    expect(closed).toEqual(["/a"]);
    expect(lc.refcountOf("/b")).toBe(1);
    expect(lc.activeRoots()).toEqual(["/b"]);
  });

  it("onSessionClose on an unknown root is a no-op", () => {
    const lc = new WorkspaceLifecycle();
    const closed: string[] = [];
    lc.onClosed((r) => closed.push(r));
    lc.onSessionClose("/ghost");
    expect(closed).toEqual([]);
  });

  it("unsubscribe stops further callbacks", () => {
    const lc = new WorkspaceLifecycle();
    const closed: string[] = [];
    const off = lc.onClosed((r) => closed.push(r));
    lc.onSessionOpen("/a");
    off();
    lc.onSessionClose("/a");
    expect(closed).toEqual([]);
  });
});

describe("WorkspaceLifecycle — busy + idle", () => {
  afterEach(() => vi.useRealTimers());

  it("emits idle after the quiet window when a root has sessions but no in-flight RPC", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(100);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a"); // arms quiet: refcount>0, busyOps 0
    vi.advanceTimersByTime(100);
    expect(idle).toEqual(["/a"]);
  });

  it("does NOT emit idle while a long RPC is in flight, re-arms after it ends (B1)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(100);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a");
    lc.onRpcStart("/a"); // busy → disarm
    vi.advanceTimersByTime(500);
    expect(idle).toEqual([]); // never fires while busy
    expect(lc.busyOpsOf("/a")).toBe(1);
    lc.onRpcEnd("/a"); // idle again → re-arm
    vi.advanceTimersByTime(100);
    expect(idle).toEqual(["/a"]);
  });

  it("stays busy until ALL nested RPCs finish", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(100);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a");
    lc.onRpcStart("/a");
    lc.onRpcStart("/a");
    lc.onRpcEnd("/a");
    vi.advanceTimersByTime(100);
    expect(idle).toEqual([]); // one RPC still in flight
    lc.onRpcEnd("/a");
    vi.advanceTimersByTime(100);
    expect(idle).toEqual(["/a"]);
  });

  it("re-checks live state in the timer callback — no idle after the root closed (B3)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(100);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a"); // arms the timer
    lc.onSessionClose("/a"); // root gone before timer fires → disarmed + deleted
    vi.advanceTimersByTime(200);
    expect(idle).toEqual([]);
  });

  it("quietMs=0 disables idle emission entirely", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(0);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a");
    vi.advanceTimersByTime(10_000);
    expect(idle).toEqual([]);
  });

  it("dispose clears pending timers", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(100);
    const idle: string[] = [];
    lc.onIdle((r) => idle.push(r));
    lc.onSessionOpen("/a");
    lc.dispose();
    vi.advanceTimersByTime(200);
    expect(idle).toEqual([]);
    expect(lc.activeRoots()).toEqual([]);
  });
});

describe("DaemonHost — workspace lifecycle wiring", () => {
  function makeHost() {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AcpServer({ input, output });
    const host = new DaemonHost({
      defaultDir: "/tmp",
      createSession: async (rootDir): Promise<Session> =>
        ({
          id: "sess1",
          rootDir,
          mcpClients: [],
          aborter: null,
          // No loop stub needed — these tests never send session/prompt.
        }) as unknown as Session,
    });
    host.attach(server);
    const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`);
    return { host, server, send };
  }

  it("session/new opens the workspace (refcount 1); detach closes it", async () => {
    const { host, server, send } = makeHost();
    const closed: string[] = [];
    host.workspaceLifecycle.onClosed((r) => closed.push(r));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp" },
    });
    await wait();
    const roots = host.workspaceLifecycle.activeRoots();
    expect(roots.length).toBe(1);
    expect(host.workspaceLifecycle.refcountOf(roots[0])).toBe(1);

    await host.detach(server);
    expect(host.workspaceLifecycle.refcountOf(roots[0])).toBe(0);
    expect(closed).toEqual(roots);
    await host.closeAll();
  });

  it("session/cancel keeps the session alive — refcount unchanged (B2)", async () => {
    const { host, server, send } = makeHost();
    const closed: string[] = [];
    host.workspaceLifecycle.onClosed((r) => closed.push(r));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp" },
    });
    await wait();
    const root = host.workspaceLifecycle.activeRoots()[0];

    send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess1" },
    });
    await wait();
    // cancel aborts the turn but does NOT remove the session → refcount stays, no close.
    expect(host.workspaceLifecycle.refcountOf(root)).toBe(1);
    expect(closed).toEqual([]);
    await host.closeAll();
  });
});

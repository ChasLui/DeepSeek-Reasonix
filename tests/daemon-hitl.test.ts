/** Daemon HITL — per-session PauseGate routes confirmations to the owning connection over JSON-RPC (Slice 4). */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpServer } from "../src/acp/server.js";
import { PauseGate } from "../src/core/pause-gate.js";
import { attachSessionGate } from "../src/daemon/host.js";

/** Two AcpServers cross-wired so the daemon's outbound session/request_permission reaches a responding client. */
function bidiPair(): {
  daemon: AcpServer;
  client: AcpServer;
  close: () => void;
} {
  const d2c = new PassThrough();
  const c2d = new PassThrough();
  const daemon = new AcpServer({ input: c2d, output: d2c });
  const client = new AcpServer({ input: d2c, output: c2d });
  return {
    daemon,
    client,
    close: () => {
      daemon.close();
      client.close();
    },
  };
}

interface PermissionParams {
  sessionId: string;
  toolCall: { rawInput: { command?: string } };
}

describe("daemon HITL — per-session gate routing", () => {
  it("round-trips a run_command confirmation to the owning client", async () => {
    const pair = bidiPair();
    const seen: string[] = [];
    pair.client.onRequest<PermissionParams, unknown>("session/request_permission", (params) => {
      seen.push(params.sessionId);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });
    const gate = new PauseGate();
    attachSessionGate(gate, pair.daemon, "sess-A", "review");

    const verdict = await gate.ask({
      kind: "run_command",
      payload: { command: "ls" },
    });
    expect(verdict).toEqual({ type: "run_once" });
    expect(seen).toEqual(["sess-A"]);
    pair.close();
  });

  it("auto-resolves under yolo without contacting the client", async () => {
    const pair = bidiPair();
    let contacted = false;
    pair.client.onRequest("session/request_permission", () => {
      contacted = true;
      return { outcome: { outcome: "cancelled" } };
    });
    const gate = new PauseGate();
    attachSessionGate(gate, pair.daemon, "sess-A", "yolo");

    const verdict = await gate.ask({
      kind: "path_access",
      payload: {
        path: "/x",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/",
        allowPrefix: "/x",
      },
    });
    expect(verdict).toEqual({ type: "run_once" });
    expect(contacted).toBe(false);
    pair.close();
  });

  it("fails closed (deny) when the client has no permission handler", async () => {
    const pair = bidiPair();
    const gate = new PauseGate();
    attachSessionGate(gate, pair.daemon, "sess-A", "review");
    // No handler on the client → ERR_METHOD_NOT_FOUND → cancelled → deny.
    const verdict = await gate.ask({
      kind: "run_command",
      payload: { command: "rm -rf /" },
    });
    expect(verdict).toEqual({ type: "deny" });
    pair.close();
  });

  it("routes two concurrent sessions' confirmations to their own ids", async () => {
    const pair = bidiPair();
    const seen: Array<{ sessionId: string; cmd?: string }> = [];
    pair.client.onRequest<PermissionParams, unknown>("session/request_permission", (params) => {
      seen.push({
        sessionId: params.sessionId,
        cmd: params.toolCall.rawInput.command,
      });
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });
    const gateA = new PauseGate();
    attachSessionGate(gateA, pair.daemon, "sess-A", "review");
    const gateB = new PauseGate();
    attachSessionGate(gateB, pair.daemon, "sess-B", "review");

    const [vA, vB] = await Promise.all([
      gateA.ask({ kind: "run_command", payload: { command: "cmdA" } }),
      gateB.ask({ kind: "run_command", payload: { command: "cmdB" } }),
    ]);
    expect(vA).toEqual({ type: "run_once" });
    expect(vB).toEqual({ type: "run_once" });
    expect(seen.find((s) => s.cmd === "cmdA")?.sessionId).toBe("sess-A");
    expect(seen.find((s) => s.cmd === "cmdB")?.sessionId).toBe("sess-B");
    pair.close();
  });
});

/** RemoteApp — minimal Ink TUI thin client over a (faked) daemon connection. */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequestParams } from "../src/acp/protocol.js";
import { PermissionModal, RemoteApp } from "../src/cli/ui/RemoteApp.js";
import type { DaemonClient, DaemonClientOptions } from "../src/daemon/client.js";

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A fake connectDaemon that captures the client options so a test can push
 *  kernel events / permission requests at the component directly. */
function fakeConnect(captured: { opts?: DaemonClientOptions }) {
  return async (_socketPath: string, opts: DaemonClientOptions = {}): Promise<DaemonClient> => {
    captured.opts = opts;
    return {
      initialize: async () => undefined,
      newSession: async () => "sess-X",
      prompt: async () => "end_turn",
      ping: async () => ({ pid: 1, version: "x", sessions: 1 }),
      close: () => undefined,
    };
  };
}

describe("RemoteApp", () => {
  it("connects, opens a session, and shows it in the prompt placeholder", async () => {
    const captured: { opts?: DaemonClientOptions } = {};
    const { lastFrame, unmount } = render(
      <RemoteApp socketPath="/x.sock" cwd="/tmp" connect={fakeConnect(captured) as never} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("session sess-X");
    unmount();
  });

  it("renders assistant text pushed over the kernel-event stream", async () => {
    const captured: { opts?: DaemonClientOptions } = {};
    const { lastFrame, unmount } = render(
      <RemoteApp socketPath="/x.sock" cwd="/tmp" connect={fakeConnect(captured) as never} />,
    );
    await tick();
    // Simulate the daemon streaming an assistant delta to this session.
    captured.opts?.onUpdate?.({
      sessionId: "sess-X",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo: hi" },
      },
    });
    await tick();
    expect(lastFrame() ?? "").toContain("echo: hi");
    unmount();
  });

  it("surfaces a forwarded permission request as a modal", async () => {
    const captured: { opts?: DaemonClientOptions } = {};
    const { lastFrame, unmount } = render(
      <RemoteApp socketPath="/x.sock" cwd="/tmp" connect={fakeConnect(captured) as never} />,
    );
    await tick();
    void captured.opts?.onPermission?.({
      sessionId: "sess-X",
      toolCall: { toolCallId: "t", title: "Run command — ls" },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    });
    await tick();
    expect(lastFrame() ?? "").toContain("Run command — ls");
    unmount();
  });
});

describe("PermissionModal", () => {
  function params(): PermissionRequestParams {
    return {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "Run command — ls" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow_always",
          name: "Allow always",
          kind: "allow_always",
        },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    };
  }

  it("renders the title and numbered options", async () => {
    const { lastFrame, unmount } = render(
      <PermissionModal params={params()} onChoose={() => {}} />,
    );
    await tick();
    const out = lastFrame() ?? "";
    expect(out).toContain("Run command — ls");
    expect(out).toContain("1) Allow once");
    expect(out).toContain("3) Reject");
    unmount();
  });

  it("selects an option by its digit key", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(<PermissionModal params={params()} onChoose={onChoose} />);
    await tick();
    stdin.write("2");
    await tick();
    expect(onChoose).toHaveBeenCalledWith("allow_always");
    unmount();
  });

  it("selects the reject option by digit", async () => {
    const onChoose = vi.fn();
    const { stdin, unmount } = render(<PermissionModal params={params()} onChoose={onChoose} />);
    await tick();
    stdin.write("3");
    await tick();
    expect(onChoose).toHaveBeenCalledWith("reject");
    unmount();
  });
});

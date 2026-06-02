/** renderSessionUpdate — kernel-event session/update → plain-text thin-client view. */

import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "../src/acp/protocol.js";
import { renderSessionUpdate } from "../src/daemon/render-update.js";

function sink() {
  const out: string[] = [];
  return { out, write: (t: string) => out.push(t) };
}

describe("renderSessionUpdate", () => {
  it("streams assistant message chunks inline", () => {
    const s = sink();
    renderSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
      s,
    );
    expect(s.out.join("")).toBe("hello");
  });

  it("hides reasoning chunks", () => {
    const s = sink();
    renderSessionUpdate(
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
      s,
    );
    expect(s.out).toEqual([]);
  });

  it("announces a pending tool call by title", () => {
    const s = sink();
    renderSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "run_command",
        status: "pending",
      },
      s,
    );
    expect(s.out.join("")).toContain("[tool run_command] running…");
  });

  it("renders a completed tool result", () => {
    const s = sink();
    renderSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      },
      s,
    );
    expect(s.out.join("")).toContain("[tool completed] ok");
  });

  it("ignores in-progress tool updates", () => {
    const s = sink();
    renderSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
      } as SessionUpdate,
      s,
    );
    expect(s.out).toEqual([]);
  });
});

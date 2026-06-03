/** Render a daemon kernel-event (session/update) to a plain-text sink — the thin interactive client's view. */

import type { SessionUpdate } from "../acp/protocol.js";

export interface UpdateSink {
  write: (text: string) => void;
}

export function renderSessionUpdate(update: SessionUpdate, sink: UpdateSink): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      sink.write(update.content.text);
      return;
    case "agent_thought_chunk":
      // Reasoning is hidden in the thin client; the TUI renders it separately.
      return;
    case "tool_call":
      if (update.status === "pending") {
        sink.write(`\n[tool ${update.title ?? update.toolCallId}] running…\n`);
      }
      return;
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        const text = update.content?.[0]?.content.text ?? "";
        sink.write(`\n[tool ${update.status}]${text ? ` ${text}` : ""}\n`);
      }
      return;
    case "plan":
      sink.write(`\n[plan] ${update.entries.length} step(s)\n`);
      return;
  }
}

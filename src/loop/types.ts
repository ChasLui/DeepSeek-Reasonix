import type { RepairReport } from "../repair/index.js";
import type { TurnStats } from "../telemetry/stats.js";

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /** Only liveness signal during a large-args tool call (no content/reasoning bytes). */
  | "tool_call_delta"
  /** Pre-dispatch ping so the TUI can show a spinner during long tool awaits. */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /** Transient indicator for silent phases; UI clears on next primary event. */
  | "status"
  /** Mid-turn steer injected as a user utterance without aborting the current turn. */
  | "steer";

export interface LoopEvent {
  turn: number;
  role: EventRole;
  content: string;
  reasoningDelta?: string | undefined;
  toolName?: string | undefined;
  /** Raw args JSON — needed by `reasonix diff` to explain why a tool was called. */
  toolArgs?: string | undefined;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number | undefined;
  /** Zero-based index of the tool call this delta belongs to (multi-tool progress). */
  toolCallIndex?: number | undefined;
  /** Count of tool calls whose args have parsed as valid JSON (UI progress, not dispatch gate). */
  toolCallReadyCount?: number | undefined;
  /** Stable id for tool_start / tool pairs — also the inflight-set key. UI uses this as the card id so it can derive `running` from `loop.inflight.has(callId)` instead of trusting end-event delivery. */
  callId?: string | undefined;
  stats?: TurnStats | undefined;
  repair?: RepairReport | undefined;
  error?: string | undefined;
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in forced-summary text. */
  forcedSummary?: boolean | undefined;
}

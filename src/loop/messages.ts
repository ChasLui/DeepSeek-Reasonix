import type { ChatMessage, ToolCall } from "../types.js";
import { isThinkingModeModel } from "./thinking.js";

/** Thinking-mode producer ⇒ reasoning_content MUST be set (even ""), or next call 400s. */
export function buildAssistantMessage(
  content: string,
  toolCalls: ToolCall[],
  producingModel: string,
  reasoningContent?: string | null,
): ChatMessage {
  const msg: ChatMessage = { role: "assistant", content };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  // Thinking-mode producer (or V4-era deepseek-chat aliases that surface
  // reasoning_content despite thinking.type="disabled") returns reasoning_content;
  // the next API round-trip 400s if we drop it. See thinking-mode-guard chain
  // anchored at src/loop/thinking.ts. Preserve unconditionally when the model is
  // recognized as thinking-capable; for compatibility aliases, fall back to "any
  // non-empty producer-supplied reasoning_content" since model-name detection
  // is too brittle.
  if (isThinkingModeModel(producingModel) || (reasoningContent && reasoningContent.length > 0)) {
    msg.reasoning_content = reasoningContent ?? "";
  }
  return msg;
}

/** Abort notices etc — caller passes its current model as the thinking-mode stamp. */
export function buildSyntheticAssistantMessage(
  content: string,
  fallbackModel: string,
): ChatMessage {
  return buildAssistantMessage(content, [], fallbackModel, "");
}

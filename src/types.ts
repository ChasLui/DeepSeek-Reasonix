export interface JSONSchema {
  type?: string | undefined;
  properties?: Record<string, JSONSchema> | undefined;
  items?: JSONSchema | undefined;
  required?: readonly string[] | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  [k: string]: unknown;
}

export interface ToolFunctionSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean | undefined;
}

export interface ToolSpec {
  type: "function";
  function: ToolFunctionSpec;
}

export interface ToolCall {
  id?: string | undefined;
  type?: "function" | undefined;
  function: {
    name: string;
    arguments: string;
  };
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content?: string | null | undefined;
  name?: string | undefined;
  prefix?: boolean | undefined;
  tool_call_id?: string | undefined;
  tool_calls?: ToolCall[] | undefined;
  /** Must round-trip in tool-loop continuations — thinking mode 400s without it. */
  reasoning_content?: string | null | undefined;
}

export interface CompletionTokensDetails {
  reasoning_tokens?: number | undefined;
}

export interface RawUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  prompt_cache_hit_tokens?: number | undefined;
  prompt_cache_miss_tokens?: number | undefined;
  completion_tokens_details?: CompletionTokensDetails | undefined;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface StreamOptions {
  include_usage?: boolean | undefined;
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[] | undefined;
  toolChoice?: ToolChoice | undefined;
  toolsStrict?: boolean | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  stop?: string | string[] | undefined;
  stream?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /** DeepSeek response_format — use { type: "json_object" } to force valid JSON. */
  responseFormat?: { type: "json_object" | "text" };
  streamOptions?: StreamOptions | undefined;
  user?: string | undefined;
  logprobs?: boolean | undefined;
  topLogprobs?: number | undefined;
  thinking?: "enabled" | "disabled" | undefined;
  reasoningEffort?: "high" | "max" | undefined;
}

export interface FimCompletionOptions {
  model: string;
  prompt: string;
  suffix?: string | undefined;
  echo?: boolean | undefined;
  logprobs?: number | undefined;
  maxTokens?: number | undefined;
  stop?: string | string[] | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type PrefixAssistantMessage = ChatMessage & {
  role: "assistant";
  content: string;
  prefix: true;
};

export type MessagesWithPrefix = [...ChatMessage[], PrefixAssistantMessage];

export type ChatPrefixOptions = Omit<
  ChatRequestOptions,
  "messages" | "thinking" | "reasoningEffort" | "stream"
> & {
  messages: MessagesWithPrefix;
  thinking?: never;
  reasoningEffort?: never;
  stream?: never;
};

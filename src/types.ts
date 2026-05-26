export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  [k: string]: unknown;
}

export interface ToolFunctionSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict?: boolean;
}

export interface ToolSpec {
  type: "function";
  function: ToolFunctionSpec;
}

export interface ToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content?: string | null;
  name?: string;
  prefix?: boolean;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Must round-trip in tool-loop continuations — thinking mode 400s without it. */
  reasoning_content?: string | null;
}

export interface CompletionTokensDetails {
  reasoning_tokens?: number;
}

export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: CompletionTokensDetails;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface StreamOptions {
  include_usage?: boolean;
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  toolsStrict?: boolean;
  temperature?: number;
  maxTokens?: number;
  stop?: string | string[];
  stream?: boolean;
  signal?: AbortSignal;
  /** DeepSeek response_format — use { type: "json_object" } to force valid JSON. */
  responseFormat?: { type: "json_object" | "text" };
  streamOptions?: StreamOptions;
  user?: string;
  logprobs?: boolean;
  topLogprobs?: number;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
}

export interface FimCompletionOptions {
  model: string;
  prompt: string;
  suffix?: string;
  echo?: boolean;
  logprobs?: number;
  maxTokens?: number;
  stop?: string | string[];
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
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

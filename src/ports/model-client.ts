/** Port: streaming chat model. Adapters: DeepSeek today; pluggable later. */

import type { ChatRequestOptions, RawUsage } from "../types.js";

export interface ModelStreamChunk {
  contentDelta?: string | undefined;
  reasoningDelta?: string | undefined;
  toolCallDelta?: {
    index: number;
    id?: string | undefined;
    name?: string | undefined;
    argumentsDelta?: string | undefined;
  };
  usage?: RawUsage | undefined;
  finishReason?: string | undefined;
}

export interface ModelClient {
  chatStream(opts: ChatRequestOptions, signal?: AbortSignal): AsyncIterable<ModelStreamChunk>;
}

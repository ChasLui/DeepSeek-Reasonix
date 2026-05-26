import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, DeepSeekRequestShapeError, Usage } from "../src/client.js";
import {
  getJsonModeEmptyResponseStats,
  resetJsonModeEmptyResponseStats,
} from "../src/telemetry/json-mode.js";
import type { ChatRequestOptions, ToolSpec } from "../src/types.js";

const okChat = {
  choices: [{ finish_reason: "stop", message: { content: "ok" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(data: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function tool(name: string): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description: "test tool",
      parameters: { type: "object", properties: {} },
    },
  };
}

function requestBody(fetchFn: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const [, init] = fetchFn.mock.calls[call]!;
  return JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
}

function clientFor(fetchFn: ReturnType<typeof vi.fn>, baseUrl?: string): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: "sk-test",
    baseUrl,
    fetch: fetchFn as unknown as typeof fetch,
    retry: { maxAttempts: 1 },
  });
}

describe("DeepSeekClient chat API surface", () => {
  it("maps stream options, user_id, logprobs, and top_logprobs", async () => {
    const fetchFn = vi.fn(async () =>
      streamResponse(
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
      ),
    );
    const client = clientFor(fetchFn);

    const chunks = [];
    for await (const chunk of client.stream({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      user: "ops_123",
      logprobs: true,
      topLogprobs: 3,
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.usage?.promptTokens).toBe(2);
    expect(requestBody(fetchFn)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      user_id: "ops_123",
      logprobs: true,
      top_logprobs: 3,
    });
  });

  it("lets callers explicitly disable streamed usage chunks", async () => {
    const fetchFn = vi.fn(async () => streamResponse("data: [DONE]\n\n"));
    const client = clientFor(fetchFn);

    for await (const _chunk of client.stream({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      streamOptions: { include_usage: false },
    })) {
      /* drain */
    }

    expect(requestBody(fetchFn).stream_options).toEqual({
      include_usage: false,
    });
  });

  it("validates user_id and top_logprobs before sending", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);
    const base: ChatRequestOptions = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
    };

    await expect(client.chat({ ...base, user: "bad space" })).rejects.toBeInstanceOf(
      DeepSeekRequestShapeError,
    );
    await expect(client.chat({ ...base, topLogprobs: 21 })).rejects.toBeInstanceOf(
      DeepSeekRequestShapeError,
    );
    await expect(client.chat({ ...base, topLogprobs: 1 })).rejects.toBeInstanceOf(
      DeepSeekRequestShapeError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes tool_choice and injects strict into tool functions", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await client.chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      tools: [tool("lookup")],
      toolsStrict: true,
      toolChoice: { type: "function", function: { name: "lookup" } },
    });

    expect(requestBody(fetchFn)).toMatchObject({
      tool_choice: { type: "function", function: { name: "lookup" } },
      tools: [{ type: "function", function: { name: "lookup", strict: true } }],
    });
  });

  it("rejects more than 128 tools", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);
    const tools = Array.from({ length: 129 }, (_v, i) => tool(`tool_${i}`));

    await expect(
      client.chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        tools,
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("routes chatPrefix to /beta without thinking payloads", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await client.chatPrefix({
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "write quicksort" },
        { role: "assistant", content: "```python\n", prefix: true },
      ],
      stop: ["```"],
    });

    const [url] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(requestBody(fetchFn)).toMatchObject({
      stop: ["```"],
      messages: [
        { role: "user", content: "write quicksort" },
        { role: "assistant", prefix: true },
      ],
    });
    expect(requestBody(fetchFn)).not.toHaveProperty("extra_body");
    expect(requestBody(fetchFn)).not.toHaveProperty("reasoning_effort");
  });

  it("uses the same prefix request shape for doctor prefix ping", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await client.pingChatPrefix();

    const [url] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(requestBody(fetchFn)).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 1,
      messages: [{ role: "user" }, { role: "assistant", content: "o", prefix: true }],
    });
    expect(requestBody(fetchFn)).not.toHaveProperty("thinking");
    expect(requestBody(fetchFn)).not.toHaveProperty("reasoning_effort");
  });

  it("routes FIM completion to beta completions with prompt and suffix fields", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            text: "    return a",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );
    const client = clientFor(fetchFn);

    const response = await client.completeFim({
      model: "deepseek-v4-pro",
      prompt: "def fib(a):\n",
      suffix: "\n    return fib(a - 1) + fib(a - 2)",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      stop: ["\n\n"],
      echo: false,
      logprobs: 2,
    });

    const [url] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/beta/completions");
    expect(requestBody(fetchFn)).toMatchObject({
      model: "deepseek-v4-pro",
      prompt: "def fib(a):\n",
      suffix: "\n    return fib(a - 1) + fib(a - 2)",
      max_tokens: 128,
      temperature: 0,
      top_p: 1,
      stop: ["\n\n"],
      stream: false,
      echo: false,
      logprobs: 2,
    });
    expect(requestBody(fetchFn)).not.toHaveProperty("messages");
    expect(requestBody(fetchFn)).not.toHaveProperty("extra_body");
    expect(requestBody(fetchFn)).not.toHaveProperty("reasoning_effort");
    expect(response).toMatchObject({
      text: "    return a",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    });
  });

  it("does not double-prefix beta FIM base URLs", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        choices: [{ finish_reason: "stop", index: 0, text: "x" }],
        usage: {},
      }),
    );
    const client = clientFor(fetchFn, "https://api.deepseek.com/beta");

    await client.completeFim({
      model: "deepseek-v4-pro",
      prompt: "const x = ",
    });

    const [url] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.deepseek.com/beta/completions");
  });

  it("validates FIM logprobs before sending", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await expect(
      client.completeFim({
        model: "deepseek-v4-pro",
        prompt: "const x = ",
        logprobs: 21,
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports JSON-mode empty content without blocking the caller", async () => {
    resetJsonModeEmptyResponseStats();
    const onJsonModeEmptyResponse = vi.fn();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        usage: {},
      }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchFn as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
      onJsonModeEmptyResponse,
    });

    const response = await client.chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "answer with json" }],
      responseFormat: { type: "json_object" },
    });

    expect(response.content).toBe("");
    expect(onJsonModeEmptyResponse).toHaveBeenCalledWith({
      model: "deepseek-v4-pro",
      finishReason: "stop",
    });
    expect(getJsonModeEmptyResponseStats()).toEqual({
      total: 1,
      byModel: { "deepseek-v4-pro": 1 },
    });
  });

  it("keeps reasoning token usage from API usage details", () => {
    const usage = Usage.fromApi({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      completion_tokens_details: { reasoning_tokens: 3 },
    });

    expect(usage.reasoningTokens).toBe(3);
  });

  it("strips assistant prefix:true field when routing chat() to main domain", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await client.chat({
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "draft", prefix: true },
      ],
    });

    const body = requestBody(fetchFn);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).not.toHaveProperty("prefix");
    expect(messages[1]).toMatchObject({ role: "assistant", content: "draft" });
  });

  it("preserves prefix:true when routing chatPrefix to /beta", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await client.chatPrefix({
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "draft", prefix: true },
      ],
    });

    const messages = requestBody(fetchFn).messages as Array<Record<string, unknown>>;
    expect(messages[1]).toMatchObject({ role: "assistant", prefix: true });
  });

  it("throws when baseUrl already ends with /beta and chat() is called", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn, "https://api.deepseek.com/beta");

    await expect(
      client.chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects chatPrefix on Azure endpoints", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn, "https://my-deploy.azure.com");

    await expect(
      client.chatPrefix({
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "o", prefix: true },
        ],
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects chat() when logprobs is not a boolean", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await expect(
      client.chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        logprobs: "true" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects chat() when messages exceed the max-array cap", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);
    const messages = Array.from({ length: 1025 }, () => ({
      role: "user" as const,
      content: "x",
    }));

    await expect(client.chat({ model: "deepseek-v4-pro", messages })).rejects.toBeInstanceOf(
      DeepSeekRequestShapeError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects completeFim when prompt+suffix bytes exceed the cap", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await expect(
      client.completeFim({
        model: "deepseek-v4-pro",
        prompt: "x".repeat(1_048_577),
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when chat() response is missing the choices array", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: { message: "bad gateway" } }));
    const client = clientFor(fetchFn);

    await expect(
      client.chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/missing choices array/);
  });

  it("rejects chatPrefix when caller passes stream:true at runtime", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await expect(
      client.chatPrefix({
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "o", prefix: true },
        ],
        stream: true as unknown as never,
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects chatPrefix when a non-final message also carries prefix:true", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(okChat));
    const client = clientFor(fetchFn);

    await expect(
      client.chatPrefix({
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "stray",
            prefix: true,
          } as unknown as never,
          { role: "assistant", content: "final", prefix: true },
        ] as unknown as never,
      }),
    ).rejects.toBeInstanceOf(DeepSeekRequestShapeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("masks bearer-token-shaped substrings in error text", async () => {
    const fakeBearer = "ZZZZZZZZZZZZZZZZZZZZ12345";
    const fetchFn = vi.fn(
      async () =>
        new Response(`upstream rejected token Bearer ${fakeBearer}`, {
          status: 401,
        }),
    );
    const client = clientFor(fetchFn);

    let err: Error | undefined;
    try {
      await client.chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/Bearer \*\*\*/);
    expect(err?.message).not.toContain(fakeBearer);
  });

  it("records json-mode empty responses observed during streaming", async () => {
    resetJsonModeEmptyResponseStats();
    const fetchFn = vi.fn(async () =>
      streamResponse(
        'data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
      ),
    );
    const client = clientFor(fetchFn);

    for await (const _chunk of client.stream({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "answer with json" }],
      responseFormat: { type: "json_object" },
    })) {
      /* drain */
    }

    expect(getJsonModeEmptyResponseStats()).toEqual({
      total: 1,
      byModel: { "deepseek-v4-pro": 1 },
    });
  });
});

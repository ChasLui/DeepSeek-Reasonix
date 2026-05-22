/** Loop surfaces read-dedup savings on the event stream when a re-read is stubbed. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../../src/client.js";
import { CacheFirstLoop, type LoopEvent } from "../../src/loop.js";
import { ImmutablePrefix } from "../../src/memory/runtime.js";
import { ToolRegistry } from "../../src/tools.js";
import { registerFilesystemTools } from "../../src/tools/filesystem.js";
import type { ChatMessage } from "../../src/types.js";

interface FakeResp {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
}

function fakeFetch(responses: FakeResp[]): typeof fetch {
  let i = 0;
  return vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        _echo_messages: body.messages as ChatMessage[],
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content ?? "",
              tool_calls: resp.tool_calls,
            },
            finish_reason: resp.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dedup-loop-"));
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\ngamma\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readCall(id: string): FakeResp {
  return {
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "a.txt" }),
        },
      },
    ],
  };
}

async function drain(loop: CacheFirstLoop, prompt: string): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const ev of loop.step(prompt)) out.push(ev);
  return out;
}

describe("loop read-dedup event surfacing", () => {
  it("emits a status event when an unchanged re-read is stubbed", async () => {
    const tools = new ToolRegistry();
    registerFilesystemTools(tools, { rootDir: root });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "sk-test",
        // turn 1: read a.txt (miss), turn 2: read a.txt again (stub), turn 3: done
        fetch: fakeFetch([readCall("c1"), readCall("c2"), { content: "done" }]),
      }),
      prefix: new ImmutablePrefix({ system: "s" }),
      tools,
      stream: false,
    });

    const events = await drain(loop, "go");

    const statuses = events.filter((e) => e.role === "status");
    const dedupStatus = statuses.find((e) => e.content.includes("read-dedup"));
    expect(dedupStatus, "expected a read-dedup status event").toBeDefined();
    expect(dedupStatus?.content).toMatch(/1 unchanged re-read stubbed/);

    // The second read_file result must be the stub, the first the full content.
    const toolResults = events.filter((e) => e.role === "tool");
    expect(toolResults[0]?.content).toContain("alpha");
    expect(toolResults[1]?.content).toMatch(/unchanged since an earlier read/);

    // Exactly one stub recorded in session-scoped stats.
    expect(loop.readDedup.getStats().dumpsSaved).toBe(1);
  });

  it("emits no dedup status when nothing was stubbed", async () => {
    const tools = new ToolRegistry();
    registerFilesystemTools(tools, { rootDir: root });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "sk-test",
        fetch: fakeFetch([readCall("c1"), { content: "done" }]),
      }),
      prefix: new ImmutablePrefix({ system: "s" }),
      tools,
      stream: false,
    });

    const events = await drain(loop, "go");
    const dedupStatus = events.find((e) => e.role === "status" && e.content.includes("read-dedup"));
    expect(dedupStatus).toBeUndefined();
  });
});

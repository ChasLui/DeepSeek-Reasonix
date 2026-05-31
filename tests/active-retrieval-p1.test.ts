// Slice 5 — pre-turn active retrieval must not violate P1 (SC-004/SC-005/C-006):
// injection lands in the append-only log AFTER the user message, never the prefix.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { buildCodeLexicalIndex } from "../src/index/lexical/code.js";
import { buildPreTurnRetrieval } from "../src/index/retrieval/active.js";
import { FIXTURE_FILES } from "../src/index/retrieval/golden.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

const roots: string[] = [];

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reasonix-active-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function capturingFetch(): {
  fetch: typeof fetch;
  bodies: Array<{ messages: ChatMessage[] }>;
} {
  const bodies: Array<{ messages: ChatMessage[] }> = [];
  const fn = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    bodies.push({ messages: body.messages });
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("pre-turn injection — P1 boundary (SC-004 / C-006)", () => {
  it("injects a role:user block AFTER the user message and never touches the prefix", async () => {
    const tools = new ToolRegistry();
    tools.register({ name: "noop", readOnly: true, fn: () => "ok" });
    const prefix = new ImmutablePrefix({
      system: "SYS",
      toolSpecs: tools.specs(),
    });
    const fpBefore = prefix.fingerprint;

    const { fetch: fakeFetch, bodies } = capturingFetch();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix,
      tools,
      model: "deepseek-v4-flash",
      stream: false,
      preTurnRetrieval: async () => ({
        content: "INJECTED_CTX",
        note: "🔎 +5 cache-miss tokens",
      }),
    });

    const events: Array<{ role?: string; content?: unknown }> = [];
    for await (const ev of loop.step("my query")) events.push(ev);

    // P1: the immutable prefix is byte-identical — injection never mutated it.
    expect(loop.prefix.fingerprint).toBe(fpBefore);

    // C-006: injection is a user-role entry strictly AFTER the turn's user message.
    const msgs = bodies[0]?.messages ?? [];
    const qIdx = msgs.findIndex((m) => m.role === "user" && m.content === "my query");
    const injIdx = msgs.findIndex((m) => m.role === "user" && m.content === "INJECTED_CTX");
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(injIdx).toBeGreaterThan(qIdx);

    // Task 5.4: per-turn cost note surfaced to the user.
    expect(
      events.some((e) => e.role === "warning" && String(e.content).includes("cache-miss")),
    ).toBe(true);
  });

  it("default-off: no preTurnRetrieval → zero behavior change", async () => {
    const tools = new ToolRegistry();
    const prefix = new ImmutablePrefix({
      system: "SYS",
      toolSpecs: tools.specs(),
    });
    const { fetch: fakeFetch, bodies } = capturingFetch();
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix,
      tools,
      model: "deepseek-v4-flash",
      stream: false,
    });

    for await (const _ev of loop.step("my query")) {
      /* drain */
    }
    const msgs = bodies[0]?.messages ?? [];
    expect(msgs.some((m) => m.content === "INJECTED_CTX")).toBe(false);
    expect(msgs.some((m) => m.role === "user" && m.content === "my query")).toBe(true);
  });
});

describe("buildPreTurnRetrieval factory (FR-006)", () => {
  it("cold repo with no index → no-op (null), never breaks the turn", async () => {
    const empty = mkdtempSync(join(tmpdir(), "reasonix-active-empty-"));
    roots.push(empty);
    const fn = buildPreTurnRetrieval(empty);
    expect(await fn("anything at all")).toBeNull();
  });

  it("returns an injection with a cache-miss token note (SC-004 honest metering)", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const inj = await buildPreTurnRetrieval(root)("PrefixCache");
    expect(inj).not.toBeNull();
    if (!inj) return;
    expect(inj.content).toContain("src/cache/prefix.ts");
    expect(inj.note ?? "").toMatch(/cache-miss tokens/);
  });

  it("precision gate skips injection when the top score is below minScore", async () => {
    const root = makeFixtureRepo();
    await buildCodeLexicalIndex(root);
    const fn = buildPreTurnRetrieval(root, { minScore: 999 });
    expect(await fn("PrefixCache")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Usage } from "../src/client.js";
import type { DeepSeekClient } from "../src/client.js";
import { ContextManager } from "../src/context-manager.js";
import type { AppendOnlyLog } from "../src/memory/runtime.js";
import type { SessionStats } from "../src/telemetry/stats.js";
import type { ChatMessage } from "../src/types.js";

function bigHead(): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "user", content: `q${i} ${"padding ".repeat(40)}` });
    msgs.push({ role: "assistant", content: `a${i} ${"padding ".repeat(40)}` });
  }
  return msgs;
}

// compactInPlace is a no-op so toMessages keeps returning the same head — this
// simulates a same-process repeat fold of byte-identical turns (the only case
// the opt-in cache helps; a live session's fold is single-directional).
function makeCM(chat: ReturnType<typeof vi.fn>): ContextManager {
  const messages = bigHead();
  return new ContextManager({
    client: { chat } as unknown as DeepSeekClient,
    log: {
      toMessages: () => messages,
      compactInPlace: vi.fn(),
    } as unknown as AppendOnlyLog,
    stats: { record: vi.fn() } as unknown as SessionStats,
    sessionName: null,
    getAbortSignal: () => new AbortController().signal,
    getCurrentTurn: () => 1,
  });
}

describe("ContextManager fold-summary cache (Q-2 / scheme 7)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reuses the cached summary on a repeat fold when REASONIX_FOLD_CACHE=1", async () => {
    vi.stubEnv("REASONIX_FOLD_CACHE", "1");
    const chat = vi.fn(async () => ({
      content: "RECAP",
      reasoningContent: "",
      usage: new Usage(),
    }));
    const cm = makeCM(chat);

    const first = await cm.fold("deepseek-v4-flash", { keepRecentTokens: 50 });
    const second = await cm.fold("deepseek-v4-flash", { keepRecentTokens: 50 });

    expect(first.folded).toBe(true);
    expect(second.folded).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("calls the summarizer on every fold when the cache is off (default)", async () => {
    const chat = vi.fn(async () => ({
      content: "RECAP",
      reasoningContent: "",
      usage: new Usage(),
    }));
    const cm = makeCM(chat);

    await cm.fold("deepseek-v4-flash", { keepRecentTokens: 50 });
    await cm.fold("deepseek-v4-flash", { keepRecentTokens: 50 });

    expect(chat).toHaveBeenCalledTimes(2);
  });
});

/** RemoteLoop — daemon-backed CacheFirstLoop facade for the rich (desktop) client. */

import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/daemon/client.js";
import type { DaemonSessionStats } from "../src/daemon/host.js";
import { RemoteLoop } from "../src/daemon/remote-loop.js";

function fakeDaemon(over: Partial<DaemonClient> = {}): DaemonClient {
  return {
    initialize: async () => undefined,
    newSession: async () => "s1",
    prompt: async (_sid, _text, onEvent) => {
      onEvent({ turn: 1, role: "assistant_delta", content: "hi" });
      onEvent({ turn: 1, role: "done", content: "" });
      return "end_turn";
    },
    ping: async () => ({ pid: 1, version: "x", sessions: 0 }),
    configure: async () => undefined,
    setBudget: async () => undefined,
    stats: async () => ({
      budgetUsd: 5,
      logTokens: 100,
      prefixSystem: "sys",
      prefixToolSpecs: "[]",
    }),
    retry: async () => "prev",
    compact: async () => undefined,
    chat: async () => "answer",
    balance: async () => ({ ok: true }),
    cancel: () => undefined,
    close: () => undefined,
    ...over,
  };
}

const snap: DaemonSessionStats = {
  budgetUsd: 1,
  logTokens: 0,
  prefixSystem: "boot",
  prefixToolSpecs: "[]",
};

describe("RemoteLoop", () => {
  it("yields the daemon's loopEvents from step()", async () => {
    const loop = new RemoteLoop(fakeDaemon(), "s1", "m", snap);
    const roles: string[] = [];
    for await (const ev of loop.step("hi")) roles.push(ev.role);
    expect(roles).toEqual(["assistant_delta", "done"]);
  });

  it("refreshes its read snapshot after a turn", async () => {
    const loop = new RemoteLoop(fakeDaemon(), "s1", "m", snap);
    expect(loop.budgetUsd).toBe(1);
    expect(loop.getCurrentLogTokens()).toBe(0);
    for await (const _ of loop.step("hi")) {
      /* drain */
    }
    expect(loop.budgetUsd).toBe(5);
    expect(loop.getCurrentLogTokens()).toBe(100);
    expect(loop.prefix.system).toBe("sys");
  });

  it("proxies abort, configure, setBudget, chat, and getBalance", async () => {
    const cancel = vi.fn();
    const configure = vi.fn(async () => undefined);
    const setBudget = vi.fn(async () => undefined);
    const loop = new RemoteLoop(fakeDaemon({ cancel, configure, setBudget }), "s1", "m", snap);

    loop.abort();
    expect(cancel).toHaveBeenCalledWith("s1");

    loop.configure({ reasoningEffort: "max" });
    expect(configure).toHaveBeenCalledWith("s1", { reasoningEffort: "max" });

    loop.setBudget(9);
    expect(loop.budgetUsd).toBe(9);
    expect(setBudget).toHaveBeenCalledWith("s1", 9);

    expect(await loop.client.chat({ model: "m", messages: [] })).toEqual({
      content: "answer",
    });
    expect(await loop.client.getBalance()).toEqual({ ok: true });
  });
});

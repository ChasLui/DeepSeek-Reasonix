/** ensureDaemon — connect-or-auto-start the single daemon (Slice 5 / daemon-only). */

import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/daemon/client.js";
import { ensureDaemon } from "../src/daemon/ensure.js";

function fakeClient(): DaemonClient {
  return {
    initialize: async () => undefined,
    newSession: async () => "s",
    prompt: async () => "end_turn",
    ping: async () => ({ pid: 1, version: "x", sessions: 0 }),
    configure: async () => undefined,
    setBudget: async () => undefined,
    stats: async () => ({ turns: [], totalCost: 0, aggregateCacheHitRatio: 0 }) as never,
    retry: async () => null,
    compact: async () => undefined,
    chat: async () => "",
    balance: async () => null,
    cancel: () => undefined,
    close: () => undefined,
  };
}

const noDelay = async (): Promise<void> => undefined;

describe("ensureDaemon", () => {
  it("returns immediately when a daemon is already reachable (no spawn)", async () => {
    const spawnDaemon = vi.fn();
    await ensureDaemon("/x.sock", {
      connect: async () => fakeClient(),
      spawnDaemon,
      delayMs: noDelay,
    });
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("spawns once and waits until the daemon becomes reachable", async () => {
    const spawnDaemon = vi.fn();
    let calls = 0;
    const connect = async (): Promise<DaemonClient> => {
      calls++;
      if (calls < 3) throw new Error("not up yet");
      return fakeClient();
    };
    await ensureDaemon("/x.sock", { connect, spawnDaemon, delayMs: noDelay });
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("throws if the daemon never comes up after auto-start", async () => {
    const spawnDaemon = vi.fn();
    const connect = async (): Promise<DaemonClient> => {
      throw new Error("never");
    };
    await expect(
      ensureDaemon("/x.sock", {
        connect,
        spawnDaemon,
        delayMs: noDelay,
        attempts: 3,
      }),
    ).rejects.toThrow(/did not become reachable/);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });
});

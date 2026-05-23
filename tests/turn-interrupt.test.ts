import { describe, expect, it, vi } from "vitest";
import { handleTurnInterrupt } from "../src/cli/ui/turn-interrupt.js";

describe("handleTurnInterrupt", () => {
  it("aborts on the first Ctrl+C, then force-quits on the second (Ctrl+C twice to exit)", () => {
    const resetPendingModals = vi.fn();
    const stopLoop = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();
    const controller = {
      turnActiveRef: { current: true },
      abortedThisTurn: { current: false },
      resetPendingModals,
      isLoopActive: () => true,
      stopLoop,
      loop: { abort },
      quitProcess,
    };

    // First press interrupts the running turn but keeps the process alive.
    expect(handleTurnInterrupt("ctrl-c", controller)).toBe("aborted");
    expect(quitProcess).not.toHaveBeenCalled();

    // Second press, while the turn is still unwinding (submittingRef stuck
    // true on a wedged turn), force-quits. Regression guard for the Warp
    // bug where two Ctrl+C couldn't exit a hung turn.
    expect(handleTurnInterrupt("ctrl-c", controller)).toBe("quit");
    expect(quitProcess).toHaveBeenCalledTimes(1);
    expect(resetPendingModals).toHaveBeenCalledTimes(1);
    expect(stopLoop).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("never quits on a repeated Esc — Esc only aborts, even on a wedged turn", () => {
    const abort = vi.fn();
    const quitProcess = vi.fn();
    const controller = {
      turnActiveRef: { current: true },
      abortedThisTurn: { current: false },
      resetPendingModals: vi.fn(),
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort },
      quitProcess,
    };

    expect(handleTurnInterrupt("escape", controller)).toBe("aborted");
    expect(handleTurnInterrupt("escape", controller)).toBe("already-aborted");
    expect(quitProcess).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("quits on Ctrl+C when no model turn is active", () => {
    const resetPendingModals = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();

    const outcome = handleTurnInterrupt("ctrl-c", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      resetPendingModals,
      isLoopActive: () => true,
      stopLoop: vi.fn(),
      loop: { abort },
      quitProcess,
    });

    expect(outcome).toBe("quit");
    expect(quitProcess).toHaveBeenCalledTimes(1);
    expect(resetPendingModals).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("stops an idle auto-loop on Esc without aborting the next turn", () => {
    const resetPendingModals = vi.fn();
    const stopLoop = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();

    const outcome = handleTurnInterrupt("escape", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      resetPendingModals,
      isLoopActive: () => true,
      stopLoop,
      loop: { abort },
      quitProcess,
    });

    expect(outcome).toBe("stopped-loop");
    expect(stopLoop).toHaveBeenCalledTimes(1);
    expect(resetPendingModals).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(quitProcess).not.toHaveBeenCalled();
  });

  it("ignores Esc during unrelated UI busy work", () => {
    const resetPendingModals = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();

    const outcome = handleTurnInterrupt("escape", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      resetPendingModals,
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort },
      quitProcess,
    });

    expect(outcome).toBe("idle");
    expect(resetPendingModals).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(quitProcess).not.toHaveBeenCalled();
  });
});

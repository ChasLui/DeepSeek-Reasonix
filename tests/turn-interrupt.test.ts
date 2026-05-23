import { describe, expect, it, vi } from "vitest";
import { handleTurnInterrupt } from "../src/cli/ui/turn-interrupt.js";

describe("handleTurnInterrupt", () => {
  it("aborts on the first Ctrl+C, then force-quits on the second (Ctrl+C twice to exit)", () => {
    const resetPendingModals = vi.fn();
    const stopLoop = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();
    const notifyCtrlCQuitArmed = vi.fn();
    const controller = {
      turnActiveRef: { current: true },
      abortedThisTurn: { current: false },
      ctrlCQuitArmedAt: { current: 0 },
      resetPendingModals,
      isLoopActive: () => true,
      stopLoop,
      loop: { abort },
      clearIdleInput: vi.fn(() => false),
      notifyCtrlCQuitArmed,
      quitProcess,
      now: () => 10_000,
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
    expect(controller.ctrlCQuitArmedAt.current).toBe(10_000);
    expect(notifyCtrlCQuitArmed).toHaveBeenCalledTimes(1);
  });

  it("never quits on a repeated Esc — Esc only aborts, even on a wedged turn", () => {
    const abort = vi.fn();
    const quitProcess = vi.fn();
    const controller = {
      turnActiveRef: { current: true },
      abortedThisTurn: { current: false },
      ctrlCQuitArmedAt: { current: 0 },
      resetPendingModals: vi.fn(),
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort },
      clearIdleInput: vi.fn(() => false),
      notifyCtrlCQuitArmed: vi.fn(),
      quitProcess,
    };

    expect(handleTurnInterrupt("escape", controller)).toBe("aborted");
    expect(handleTurnInterrupt("escape", controller)).toBe("already-aborted");
    expect(quitProcess).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("arms quit on the first idle Ctrl+C, then quits on the second within the window", () => {
    const resetPendingModals = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();
    const clearIdleInput = vi.fn(() => true);
    const notifyCtrlCQuitArmed = vi.fn();
    const ctrlCQuitArmedAt = { current: 0 };
    let now = 10_000;

    const outcome = handleTurnInterrupt("ctrl-c", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      ctrlCQuitArmedAt,
      resetPendingModals,
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort },
      clearIdleInput,
      notifyCtrlCQuitArmed,
      quitProcess,
      now: () => now,
    });

    expect(outcome).toBe("quit-armed");
    expect(quitProcess).not.toHaveBeenCalled();
    expect(clearIdleInput).toHaveBeenCalledTimes(1);
    expect(notifyCtrlCQuitArmed).toHaveBeenCalledTimes(1);
    expect(ctrlCQuitArmedAt.current).toBe(10_000);
    expect(resetPendingModals).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();

    now = 11_000;
    expect(
      handleTurnInterrupt("ctrl-c", {
        turnActiveRef: { current: false },
        abortedThisTurn: { current: false },
        ctrlCQuitArmedAt,
        resetPendingModals,
        isLoopActive: () => false,
        stopLoop: vi.fn(),
        loop: { abort },
        clearIdleInput,
        notifyCtrlCQuitArmed,
        quitProcess,
        now: () => now,
      }),
    ).toBe("quit");
    expect(quitProcess).toHaveBeenCalledTimes(1);
  });

  it("re-arms idle Ctrl+C after the quit window expires", () => {
    const quitProcess = vi.fn();
    const notifyCtrlCQuitArmed = vi.fn();
    const ctrlCQuitArmedAt = { current: 10_000 };
    const outcome = handleTurnInterrupt("ctrl-c", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      ctrlCQuitArmedAt,
      resetPendingModals: vi.fn(),
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort: vi.fn() },
      clearIdleInput: vi.fn(() => false),
      notifyCtrlCQuitArmed,
      quitProcess,
      now: () => 15_001,
    });

    expect(outcome).toBe("quit-armed");
    expect(quitProcess).not.toHaveBeenCalled();
    expect(notifyCtrlCQuitArmed).toHaveBeenCalledTimes(1);
    expect(ctrlCQuitArmedAt.current).toBe(15_001);
  });

  it("stops an idle auto-loop on Esc without aborting the next turn", () => {
    const resetPendingModals = vi.fn();
    const stopLoop = vi.fn();
    const abort = vi.fn();
    const quitProcess = vi.fn();

    const outcome = handleTurnInterrupt("escape", {
      turnActiveRef: { current: false },
      abortedThisTurn: { current: false },
      ctrlCQuitArmedAt: { current: 0 },
      resetPendingModals,
      isLoopActive: () => true,
      stopLoop,
      loop: { abort },
      clearIdleInput: vi.fn(() => false),
      notifyCtrlCQuitArmed: vi.fn(),
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
      ctrlCQuitArmedAt: { current: 0 },
      resetPendingModals,
      isLoopActive: () => false,
      stopLoop: vi.fn(),
      loop: { abort },
      clearIdleInput: vi.fn(() => false),
      notifyCtrlCQuitArmed: vi.fn(),
      quitProcess,
    });

    expect(outcome).toBe("idle");
    expect(resetPendingModals).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(quitProcess).not.toHaveBeenCalled();
  });
});

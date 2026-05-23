export type TurnInterruptKey = "escape" | "ctrl-c";
export type TurnInterruptOutcome = "aborted" | "already-aborted" | "stopped-loop" | "idle" | "quit";

export interface TurnInterruptController {
  turnActiveRef: { readonly current: boolean };
  abortedThisTurn: { current: boolean };
  resetPendingModals: () => void;
  isLoopActive: () => boolean;
  stopLoop: () => void;
  loop: { abort: () => void };
  quitProcess: () => void;
}

export function handleTurnInterrupt(
  key: TurnInterruptKey,
  {
    turnActiveRef,
    abortedThisTurn,
    resetPendingModals,
    isLoopActive,
    stopLoop,
    loop,
    quitProcess,
  }: TurnInterruptController,
): TurnInterruptOutcome {
  if (turnActiveRef.current) {
    if (abortedThisTurn.current) {
      // The turn is already unwinding from a first interrupt. A second
      // Ctrl+C means "I want OUT" — honor the universal "Ctrl+C twice
      // force-quits" contract even when the turn is wedged (hung network,
      // slow Warp PTY) and never flips submittingRef back to idle. Esc
      // never escalates this way — it only ever aborts a turn.
      if (key === "ctrl-c") {
        quitProcess();
        return "quit";
      }
      return "already-aborted";
    }
    abortedThisTurn.current = true;
    resetPendingModals();
    if (isLoopActive()) stopLoop();
    loop.abort();
    return "aborted";
  }

  if (key === "escape" && isLoopActive()) {
    stopLoop();
    return "stopped-loop";
  }

  if (key === "ctrl-c") {
    quitProcess();
    return "quit";
  }

  return "idle";
}

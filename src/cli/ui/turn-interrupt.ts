export type TurnInterruptKey = "escape" | "ctrl-c";
export type TurnInterruptOutcome =
  | "aborted"
  | "already-aborted"
  | "stopped-loop"
  | "idle"
  | "quit-armed"
  | "quit";

export const CTRL_C_QUIT_WINDOW_MS = 5000;

export interface TurnInterruptController {
  turnActiveRef: { readonly current: boolean };
  abortedThisTurn: { current: boolean };
  ctrlCQuitArmedAt: { current: number };
  resetPendingModals: () => void;
  isLoopActive: () => boolean;
  stopLoop: () => void;
  loop: { abort: () => void };
  clearIdleInput: () => boolean;
  notifyCtrlCQuitArmed: () => void;
  quitProcess: () => void;
  now?: () => number;
  ctrlCQuitWindowMs?: number;
}

export function handleTurnInterrupt(
  key: TurnInterruptKey,
  {
    turnActiveRef,
    abortedThisTurn,
    ctrlCQuitArmedAt,
    resetPendingModals,
    isLoopActive,
    stopLoop,
    loop,
    clearIdleInput,
    notifyCtrlCQuitArmed,
    quitProcess,
    now = Date.now,
    ctrlCQuitWindowMs = CTRL_C_QUIT_WINDOW_MS,
  }: TurnInterruptController,
): TurnInterruptOutcome {
  const armCtrlCQuit = (time: number): TurnInterruptOutcome => {
    ctrlCQuitArmedAt.current = time;
    notifyCtrlCQuitArmed();
    return "quit-armed";
  };

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
    if (key === "ctrl-c") {
      ctrlCQuitArmedAt.current = now();
      notifyCtrlCQuitArmed();
    }
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
    const time = now();
    if (ctrlCQuitArmedAt.current > 0 && time - ctrlCQuitArmedAt.current <= ctrlCQuitWindowMs) {
      quitProcess();
      return "quit";
    }
    if (isLoopActive()) stopLoop();
    clearIdleInput();
    return armCtrlCQuit(time);
  }

  return "idle";
}

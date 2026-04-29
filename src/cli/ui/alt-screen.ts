/** Alt-screen lifecycle — restore must be idempotent and run on SIGINT/SIGTERM/exit so the user's main buffer always comes back. */

import { useEffect } from "react";

/** True iff stdout looks like a real TTY we should write escapes to. */
function isInteractiveTty(): boolean {
  return Boolean(process.stdout?.isTTY);
}

/** Module-level mirror of "is mouse tracking active right now?". Mutated
 *  by both `useAltScreen` (on mount) and `setMouseTracking` (slash command). */
let mouseTrackingOn = false;

/** Mode 1000 (not 1002) so Shift+drag still does native terminal selection. */
export function useAltScreen(): void {
  useEffect(() => {
    if (!isInteractiveTty()) return;
    // Enter alt buffer + clear + cursor home + basic mouse tracking
    // with SGR coordinates. Mode 1000 = press/release only (includes
    // wheel as buttons 64/65). 1006 = SGR-encoded coords. Together
    // they let us read the wheel without intercepting drag motion.
    //
    // Note on kitty keyboard protocol (\x1b[>1u): tried in 0.13.x but
    // rolled back — terminals without protocol support sometimes
    // displayed the escape as visible chars, distorting layout. To
    // re-enable safely we'd need terminal-feature detection (DA1 /
    // DA2 query response) before pushing the flag.
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h");
    mouseTrackingOn = true;

    // Belt-and-suspenders restore on every plausible exit path.
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        // Disable every mouse mode we might have turned on (1000 +
        // 1002 + 1006), then leave alt screen.
        process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
      } catch {
        /* terminal closed, nothing to do */
      }
    };

    process.once("exit", restore);
    process.once("SIGINT", () => {
      restore();
      // Re-emit so default exit-on-SIGINT can still fire.
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      restore();
      process.exit(143);
    });

    return restore;
  }, []);
}

export function setMouseTracking(on: boolean): void {
  if (!isInteractiveTty()) return;
  if (on === mouseTrackingOn) return;
  if (on) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  } else {
    // Disable both 1000 and 1002 modes (we may have inherited the
    // older 1002 default from a long-running session) plus SGR.
    process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  }
  mouseTrackingOn = on;
}
export function isMouseTrackingOn(): boolean {
  return mouseTrackingOn;
}

/** Alt-screen lifecycle — restore must be idempotent and run on SIGINT/SIGTERM/exit so the user's main buffer always comes back. */

import { useEffect } from "react";

function isInteractiveTty(): boolean {
  return Boolean(process.stdout?.isTTY);
}

export function useAltScreen(): void {
  useEffect(() => {
    if (!isInteractiveTty()) return;
    // 1002 = button-event tracking (press + drag + release); 1006 = SGR coords.
    // Shift+drag bypasses tracking for native terminal selection.
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006h");

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l");
      } catch {
        /* terminal closed */
      }
    };

    process.once("exit", restore);
    process.once("SIGINT", () => {
      restore();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      restore();
      process.exit(143);
    });

    return restore;
  }, []);
}

/** `reasonix code --remote` — mount the minimal Ink TUI thin client against the running daemon. */

import { resolve } from "node:path";
import { render } from "ink";
import React from "react";
import { daemonSocketPath } from "../../storage/path.js";
import { RemoteApp } from "../ui/RemoteApp.js";

export interface CodeRemoteOptions {
  cwd?: string;
  socketPath?: string;
}

export async function codeRemoteCommand(opts: CodeRemoteOptions): Promise<void> {
  // Ink needs raw mode (a real terminal). Fail friendly instead of crashing on a pipe.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "reasonix code --remote needs an interactive terminal. For scripting, use `reasonix run --remote <task>`.\n",
    );
    process.exit(1);
  }
  const socketPath = opts.socketPath ?? daemonSocketPath();
  const cwd = resolve(opts.cwd ?? process.cwd());
  const { waitUntilExit } = render(<RemoteApp socketPath={socketPath} cwd={cwd} />, {
    exitOnCtrlC: true,
  });
  await waitUntilExit();
}

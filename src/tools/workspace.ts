/** Tool fn validates + throws WorkspaceConfirmationError; App owns the actual setCwd. No always_allow — each root is its own trust scope. */

import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import type { ToolRegistry } from "../tools.js";

export class WorkspaceConfirmationError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `change_workspace: switching to "${path}" needs the user's approval before it takes effect. STOP calling tools now — the TUI has already prompted the user to press Enter (switch) or Esc (deny). Wait for their next message; it will either confirm the switch (and your subsequent file/shell tools will resolve against the new root) or tell you to continue without changing directories.`,
    );
    this.name = "WorkspaceConfirmationError";
    this.path = path;
  }
}

export interface ChangeWorkspaceArgs {
  path: string;
}

/** Throws WorkspaceConfirmationError; App.tsx does the actual swap on user approval. */
export function registerWorkspaceTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "change_workspace",
    description:
      "Switch the session's working directory to a different project root. Re-registers filesystem / shell / memory tools against the new path so subsequent file reads, edits, and run_command calls all land there. EVERY switch requires explicit user approval via a modal — do NOT batch switches or chain a switch with subsequent tool calls before the user has confirmed. Use ONLY when the user explicitly asked to change directory or open a different project; never use to 'preview' a sibling repo. MCP servers stay anchored to the original launch root (their child processes can't be reconnected mid-session); the modal warns the user about this.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Target directory. Absolute paths land verbatim. Leading `~` expands to the user's home. Relative paths resolve against the user's launch cwd (not the current session root, so paths the user typed in chat resolve where they expect).",
        },
      },
    },
    fn: (rawArgs) => {
      const args = (rawArgs ?? {}) as Partial<ChangeWorkspaceArgs>;
      if (typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("change_workspace: `path` must be a non-empty string");
      }
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const expanded =
        args.path.startsWith("~") && home ? pathMod.join(home, args.path.slice(1)) : args.path;
      const abs = pathMod.resolve(expanded);
      if (!existsSync(abs)) {
        throw new Error(`change_workspace: path does not exist — ${abs}`);
      }
      try {
        if (!statSync(abs).isDirectory()) {
          throw new Error(`change_workspace: not a directory — ${abs}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`change_workspace: path does not exist — ${abs}`);
        }
        throw err;
      }
      // Always defer to the user. The tool itself does not switch —
      // approval drives the swap in App.tsx.
      throw new WorkspaceConfirmationError(abs);
    },
  });
  return registry;
}

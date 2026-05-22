// Session-level static toolset gating: prune the registry at loop construction so unselected tools never enter the cached prefix.

import type { ToolRegistry } from "../tools.js";

/** Minimal tools the agent always keeps even under a selected toolset, so gating a workspace to e.g. one MCP server never leaves it unable to read/edit/run. */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "search_content",
  "list_directory",
  "run_command",
  "todo_write",
]);

/** True when a tool belongs in the session: no gating (null selection), explicitly selected, or essential. MCP tools (never essential) reduce to `selection.has(name)`. Shared by the session-start prune and the MCP hot-add gate so both apply identical logic. */
export function isToolSelected(name: string, selection: ReadonlySet<string> | null): boolean {
  return selection === null || selection.has(name) || ESSENTIAL_TOOLS.has(name);
}

/** Prune the registry IN PLACE to `selection ∪ ESSENTIAL`, preserving insertion order so the cached prefix stays a deterministic subsequence. Mutates so every consumer of this one registry (prefix specs, loop, MCP hot-add) stays in sync. No-op when selection is null (gating off) or tools is undefined — examples/probes that pass no selection are byte-identical to today. */
export function applySessionToolset(
  tools: ToolRegistry | undefined,
  selection: ReadonlySet<string> | null,
): void {
  if (!tools || selection === null) return;
  for (const spec of tools.specs()) {
    if (!isToolSelected(spec.function.name, selection)) {
      tools.unregister(spec.function.name);
    }
  }
}

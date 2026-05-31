/** search_tools meta-tool (FR-003/009): query the deferred catalog by intent.
 *  Registration is gated by FR-010 — skipped entirely when disabled. */

import type { ToolRegistry } from "../tools.js";
import type { ToolCatalog } from "./catalog.js";

export interface SearchToolsOptions {
  catalog: ToolCatalog;
  /** FR-010 activation gate — when false, search_tools is not registered. */
  enabled?: boolean;
  /** Slice 3 wires real unlock state; default treats everything as not-yet-unlocked. */
  isUnlocked?: (source: string, name: string) => boolean;
}

const DESCRIPTION =
  "Search the deferred tool catalog by intent and surface matching tools to unlock. Use this when you need a capability that is not in your current tool list (e.g. a specific MCP server's action).";

/** Register search_tools unless the FR-010 gate disables it. Returns whether it registered. */
export function registerSearchTools(registry: ToolRegistry, opts: SearchToolsOptions): boolean {
  if (opts.enabled === false) return false;
  registry.register({
    name: "search_tools",
    description: DESCRIPTION,
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of the capability you need.",
        },
        limit: {
          type: "number",
          description: "Max tools to return, 1-20 (default 8).",
        },
      },
      required: ["query"],
    },
    fn: (args: { query?: unknown; limit?: unknown }) => {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : 8;
      if (!query.trim()) return "Provide a `query` describing the capability you need.";
      const hits = opts.catalog.search(query, limit);
      if (hits.length === 0) return `No tools matched "${query}". Try different wording.`;
      const lines = hits.map((h) => {
        // Skills aren't prefix tools — they're invoked by name through run_skill,
        // never unlocked/added to the tool list (Slice 5).
        if (h.source === "skill") {
          return `- ${h.name} (skill): ${h.description} — invoke with run_skill({ name: "${h.name}", arguments: "<task>" })`;
        }
        const tag = opts.isUnlocked?.(h.source, h.name) ? " [already available]" : "";
        const params = h.paramsSummary ? ` — ${h.paramsSummary}` : "";
        return `- ${h.name} (${h.source})${tag}: ${h.description}${params}`;
      });
      return `Found ${hits.length} tool(s) for "${query}":\n${lines.join("\n")}`;
    },
  });
  return true;
}

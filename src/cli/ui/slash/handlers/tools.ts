/** /tools — inspect tiered tool exposure: active vs deferred counts, unlock
 *  audit trail (FR-008), and `/tools search <query>` over the deferred catalog. */

import type { CacheFirstLoop } from "@/loop.js";
import { getDb } from "@/storage/db.js";
import { listUnlockedTools } from "@/storage/unlocked-tools-repo.js";
import { PREFIX_MAX_TIER } from "@/tools.js";
import { type CatalogToolInput, ToolCatalog } from "@/tools/catalog.js";
import type { SlashHandler } from "../dispatch.js";

function groupKey(name: string): string {
  const i = name.indexOf("_");
  return i > 0 ? name.slice(0, i) : name;
}

function deferredInputs(loop: CacheFirstLoop): CatalogToolInput[] {
  return loop.tools
    .specs()
    .filter((s) => loop.tools.tierOf(s.function.name) > PREFIX_MAX_TIER)
    .map((spec) => ({
      source: `mcp:${groupKey(spec.function.name)}`,
      tier: loop.tools.tierOf(spec.function.name),
      spec,
    }));
}

function searchDeferred(loop: CacheFirstLoop, query: string): string {
  const inputs = deferredInputs(loop);
  if (inputs.length === 0) {
    return "No deferred tools — every tool is already in your prefix.";
  }
  const hits = ToolCatalog.build(inputs).search(query, 10);
  if (hits.length === 0) return `No deferred tools matched "${query}".`;
  const lines = hits.map((h) => `  ${h.name} (${h.source}) — ${h.description}`);
  return `Deferred tools matching "${query}":\n${lines.join("\n")}`;
}

const tools: SlashHandler = (args, loop) => {
  if (args[0] === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      return { info: "Usage: /tools search <description of the capability>" };
    }
    return { info: searchDeferred(loop, query) };
  }

  const specs = loop.tools.specs();
  const deferred = specs.filter((s) => loop.tools.tierOf(s.function.name) > PREFIX_MAX_TIER);
  const activeCount = specs.length - deferred.length;
  if (deferred.length === 0) {
    return {
      info: `Tools: ${activeCount} in prefix, 0 deferred. Tiered exposure is inactive (set "toolTiers" in config to defer bloated tool sets).`,
    };
  }

  const byGroup = new Map<string, number>();
  for (const s of deferred) {
    const g = groupKey(s.function.name);
    byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
  }
  const groups = [...byGroup.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([g, c]) => `${g} (${c})`)
    .join(", ");

  let unlocked: string[] = [];
  if (loop.sessionName) {
    try {
      unlocked = listUnlockedTools(getDb(), loop.sessionName).map((r) => r.name);
    } catch {
      /* audit read is best-effort */
    }
  }
  const unlockedLine = unlocked.length ? `\nUnlocked this session: ${unlocked.join(", ")}` : "";

  return {
    info: `Tools: ${activeCount} active in prefix, ${deferred.length} deferred (catalog-only).\nDeferred areas: ${groups}.${unlockedLine}\nFind + unlock with /tools search <capability> (or call search_tools mid-task).`,
  };
};

export const handlers = { tools };

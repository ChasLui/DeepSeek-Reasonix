/** Tiered-exposure activation (FR-004/005/009/010): assign tiers from config,
 *  build the deferred catalog, register search_tools, emit the capability-hint. */

import type { ReasonixConfig } from "../config.js";
import { type CatalogSkill, skillsIndexExceedsCap } from "../skills.js";
import type { Db } from "../storage/db.js";
import { PREFIX_MAX_TIER, type ToolRegistry } from "../tools.js";
import { type CatalogToolInput, ToolCatalog } from "./catalog.js";
import { registerSearchTools } from "./search-tools.js";

/** Server/group key = text before the first underscore (MCP namePrefix is `${server}_`). */
function firstToken(name: string): string {
  const i = name.indexOf("_");
  return i > 0 ? name.slice(0, i) : name;
}

/** Source tag for the catalog: deferred tools are MCP-bridged in v1 (`mcp:<server>`); the rest are builtin. */
function sourceOf(registry: ToolRegistry, name: string): string {
  return registry.tierOf(name) > PREFIX_MAX_TIER ? `mcp:${firstToken(name)}` : "builtin";
}

/** Apply per-tool-name tier overrides from config (FR-005). Returns the count actually set. */
export function applyTierOverrides(registry: ToolRegistry, cfg: ReasonixConfig): number {
  const tiers = cfg.toolTiers?.tiers;
  if (!tiers) return 0;
  let n = 0;
  for (const [name, tier] of Object.entries(tiers)) {
    if (registry.setTier(name, tier)) n++;
  }
  return n;
}

/** mcpDeferThreshold (FR-005): if a server bridged ≥ threshold tools, defer them all to Tier 2. mcpDefaultTier is applied earlier, at bridge time. */
export function applyMcpServerTier(
  registry: ToolRegistry,
  registeredNames: readonly string[],
  cfg: ReasonixConfig,
): void {
  const threshold = cfg.toolTiers?.mcpDeferThreshold;
  if (!threshold || threshold <= 0) return;
  if (registeredNames.length < threshold) return;
  for (const name of registeredNames) registry.setTier(name, 2);
}

/** Resolve the default tier for bridged MCP tools — threaded into bridgeMcpTools opts. */
export function resolveMcpDefaultTier(cfg: ReasonixConfig): number | undefined {
  return cfg.toolTiers?.mcpDefaultTier;
}

/** FR-009 capability-hint: a STABLE summary of deferred tools by server group
 *  (+ a skills note when the index spilled), telling the model to reach them via
 *  search_tools. "" when nothing deferred → prompt unchanged (FR-010). */
export function buildCapabilityHint(deferredNames: readonly string[], skillCount = 0): string {
  if (deferredNames.length === 0 && skillCount === 0) return "";
  let toolsClause = "";
  if (deferredNames.length > 0) {
    const byGroup = new Map<string, number>();
    for (const name of deferredNames) {
      const g = firstToken(name);
      byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
    }
    const areas = [...byGroup.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([g, n]) => `${g} (${n})`)
      .join(", ");
    toolsClause = ` ${deferredNames.length} tool(s) across: ${areas}.`;
  }
  const skillsClause =
    skillCount > 0
      ? " Some skills are not listed above; search_tools also finds them — invoke a found skill with run_skill, not as a direct tool."
      : "";
  return `\n\n[Deferred capabilities] When you need something not in your current tool list, call \`search_tools\` with a short description — it returns matching tools/skills you can then use.${toolsClause}${skillsClause}`;
}

/** Map skills into catalog entries (source "skill", deferred tier). Skills are
 *  never addTool'd — a search hit just tells the model to use run_skill. */
export function skillCatalogInputs(skills: readonly CatalogSkill[]): CatalogToolInput[] {
  return skills.map((s) => ({
    source: "skill",
    tier: 2,
    spec: {
      type: "function" as const,
      function: {
        name: s.name,
        description: s.description,
        parameters: { type: "object", properties: {} },
      },
    },
  }));
}

export interface TieringResult {
  /** Number of tools above PREFIX_MAX_TIER (catalog-only). */
  deferredCount: number;
  /** System-prompt suffix; "" when nothing deferred (FR-010). */
  capabilityHint: string;
  /** True iff search_tools was registered (FR-010 gate). */
  searchToolsRegistered: boolean;
}

/** Activate tiered exposure before prefix build: apply config overrides, build
 *  the catalog (tools + spilled-over skills), register search_tools (FR-010 gate),
 *  return the capability-hint. No-op unless something is deferred or skills spill. */
export function activateToolTiering(
  registry: ToolRegistry,
  cfg: ReasonixConfig,
  db: Db | null = null,
  skills: readonly CatalogSkill[] = [],
): TieringResult {
  applyTierOverrides(registry, cfg);

  const deferredNames = registry
    .specs()
    .map((s) => s.function.name)
    .filter((name) => registry.tierOf(name) > PREFIX_MAX_TIER);

  // Slice 5: skills join the catalog only when their index would overflow the
  // prefix cap (else they're fully listed already — no need, keeps FR-010).
  const skillsOverflow = skillsIndexExceedsCap(skills);
  const skillCount = skillsOverflow ? skills.length : 0;

  if (deferredNames.length === 0 && !skillsOverflow) {
    return {
      deferredCount: 0,
      capabilityHint: "",
      searchToolsRegistered: false,
    };
  }

  const inputs: CatalogToolInput[] = registry.specs().map((spec) => ({
    source: sourceOf(registry, spec.function.name),
    tier: registry.tierOf(spec.function.name),
    spec,
  }));
  if (skillsOverflow) inputs.push(...skillCatalogInputs(skills));
  const catalog = ToolCatalog.build(inputs, db);
  const registered = registerSearchTools(registry, { catalog, enabled: true });

  return {
    deferredCount: deferredNames.length,
    capabilityHint: buildCapabilityHint(deferredNames, skillCount),
    searchToolsRegistered: registered,
  };
}

/** Preset table — branch and harvest stay off here so users never get ambushed into N× cost without opting in. */

import type { PresetName } from "../../config.js";

export interface PresetSettings {
  model: string;
  reasoningEffort: "high" | "max";
  autoEscalate: boolean;
  /** Pillar-2 harvest. Always false in presets — opt-in via /harvest. */
  harvest: boolean;
  /** Branch budget. Always 1 in presets — opt-in via /branch. */
  branch: number;
}

/** Old names `fast`/`smart`/`max` aliased via `resolvePreset` so legacy configs still load. */
export const PRESETS: Record<"auto" | "flash" | "pro", PresetSettings> = {
  // auto — flash baseline + auto-escalate to pro when the model emits
  // <<<NEEDS_PRO>>> OR after 3+ tool failure signals in one turn.
  // The default: cheap when easy, smart when hard.
  auto: {
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
    autoEscalate: true,
    harvest: false,
    branch: 1,
  },
  // flash — always flash, never escalate. `/pro` still arms a single
  // manual turn; auto-promotion is the thing this disables. Use when
  // you want predictable cost per turn.
  flash: {
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
    autoEscalate: false,
    harvest: false,
    branch: 1,
  },
  // pro — always pro. Hard pin; the model never downgrades. Use for
  // multi-turn architecture work where flash is just going to keep
  // escalating anyway and the back-and-forth wastes turns.
  pro: {
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    autoEscalate: false,
    harvest: false,
    branch: 1,
  },
};

export const PRESET_DESCRIPTIONS: Record<
  "auto" | "flash" | "pro",
  { headline: string; cost: string }
> = {
  auto: {
    headline: "flash → pro on hard turns",
    cost: "default · ~96% turns stay on flash · pro kicks in only when needed",
  },
  flash: {
    headline: "v4-flash always",
    cost: "cheapest · predictable · /pro still works for a one-turn bump",
  },
  pro: {
    headline: "v4-pro always",
    cost: "~3× flash (5/31 discount) / ~12× full price · for hard multi-turn work",
  },
};

/** Legacy aliases: fast→flash+high, smart→auto, max→pro. Unknown names fall through to auto. */
export function resolvePreset(name: PresetName | undefined): PresetSettings {
  if (name === "auto" || name === "flash" || name === "pro") return PRESETS[name];
  if (name === "fast") return { ...PRESETS.flash, reasoningEffort: "high" };
  if (name === "smart") return PRESETS.auto;
  if (name === "max") return PRESETS.pro;
  return PRESETS.auto;
}

/** Canonical name for storage / display — unknown values become auto. */
export function canonicalPresetName(name: PresetName | undefined): "auto" | "flash" | "pro" {
  if (name === "auto" || name === "flash" || name === "pro") return name;
  return "auto";
}

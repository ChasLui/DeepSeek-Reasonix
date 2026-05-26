export const LEGACY_MODEL_MIGRATION = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
} as const;

export type LegacyModelId = keyof typeof LEGACY_MODEL_MIGRATION;

export function legacyModelTarget(model: string): string | null {
  return LEGACY_MODEL_MIGRATION[model as LegacyModelId] ?? null;
}

export function isLegacyModelId(model: string): model is LegacyModelId {
  return legacyModelTarget(model) !== null;
}

export function withoutLegacyModelIds(models: ReadonlyArray<string>): string[] {
  return models.filter((model) => !isLegacyModelId(model));
}

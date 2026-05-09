import { loadTheme, resolveThemePreference, saveTheme } from "@/config.js";
import { type ThemeName, isThemeName, listThemeNames } from "../../theme/tokens.js";
import type { SlashHandler } from "../dispatch.js";

const themeChoices = ["auto", ...listThemeNames()] as const;

function formatThemeStatus(): string {
  const configured = loadTheme();
  const active = resolveThemePreference(configured, process.env.REASONIX_THEME);
  const source = configured && configured !== "auto" ? "config" : "env/default";

  return [
    `theme: ${active} (${source})`,
    `configured: ${configured ?? "unset"}`,
    `available: ${themeChoices.join(", ")}`,
    "usage: /theme <name|auto>",
  ].join("\n");
}

function isThemeChoice(value: string): value is ThemeName | "auto" {
  return value === "auto" || isThemeName(value);
}

const theme: SlashHandler = (args) => {
  const next = args[0];
  if (!next) return { info: formatThemeStatus() };

  if (!isThemeChoice(next)) {
    return { info: `unknown theme: ${next}\navailable: ${themeChoices.join(", ")}` };
  }

  saveTheme(next);
  const active = resolveThemePreference(next, process.env.REASONIX_THEME);
  return { info: `theme saved: ${next}\nactive on next launch: ${active}` };
};

export const handlers: Record<string, SlashHandler> = {
  theme,
};

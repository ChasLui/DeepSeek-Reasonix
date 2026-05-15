export const THEME = {
  DARK: "dark",
  LIGHT: "light",
} as const;

export type Theme = (typeof THEME)[keyof typeof THEME];

export function isTheme(value: unknown): value is Theme {
  return value === THEME.DARK || value === THEME.LIGHT;
}
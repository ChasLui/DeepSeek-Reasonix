export const STATUS = {
  ok: "✓",
  running: "▶",
  queued: "○",
  failed: "✗",
  blocked: "!",
  collapsed: "▸",
  expanded: "▾",
  focused: "●",
} as const;

export const STRUCT = {
  bar: "▎",
  thinBar: "▏",
  rule: "─",
  dot: "·",
  arrow: "›",
} as const;

export const DENSITY = {
  full: "█",
  high: "▓",
  mid: "▒",
  low: "░",
  on: "▰",
  off: "▱",
} as const;

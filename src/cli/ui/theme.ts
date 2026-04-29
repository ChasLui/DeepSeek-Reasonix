/** Brand gradient — REASONIX wordmark sweep, reused for accents / progress / dividers. */
export const GRADIENT: ReadonlyArray<string> = [
  "#5eead4", // teal
  "#67e8f9", // cyan
  "#7dd3fc", // sky
  "#93c5fd", // blue
  "#a5b4fc", // indigo
  "#c4b5fd", // violet
  "#d8b4fe", // purple
  "#f0abfc", // fuchsia
];

/** Tailwind 400/500 row — keeps tone consistent with GRADIENT. */
export const COLOR = {
  primary: "#67e8f9", // cyan-300
  accent: "#c4b5fd", // violet-300
  brand: "#5eead4", // teal-300

  user: "#67e8f9", // user message glyph + bar
  assistant: "#86efac", // green-300, assistant glyph + bar
  tool: "#fcd34d", // amber-300, tool ok pill bg
  toolErr: "#fda4af", // rose-300, tool err pill bg
  info: "#94a3b8", // slate-400, info / dim
  warn: "#fbbf24", // amber-400
  err: "#f87171", // red-400
  ok: "#4ade80", // green-400
} as const;

export const GLYPH = {
  brand: "◈",
  user: "◇",
  assistant: "◆",
  toolOk: "▣",
  toolErr: "▥",
  warn: "▲",
  err: "✦",
  arrow: "›",
  bullet: "·",
  bar: "▎",
  thinBar: "▏",
  block: "█",
  shade1: "░",
  shade2: "▒",
  shade3: "▓",

  // Status icons — checkbox-style states used across plan steps,
  // job rows, history entries. Pair with the COLOR semantics:
  // done→ok, cur→primary, pending→info-faint, fail→err.
  done: "✓",
  cur: "▸",
  pending: "○",
  fail: "✗",
  running: "●",

  // Tree-drawing chars for hierarchical lists (plan steps, sub-loops,
  // hook attachments). 1 cell each; render fine in every monospace
  // font we've tested.
  branch: "┣",
  branchEnd: "┗",
  branchStub: "┃",
  rule: "─",

  // Spinner frames — 4-step rotation. Cycle every 200ms via setInterval
  // (Ink's useEffect setState pattern). Equivalent to ink-spinner but
  // with our own cadence + character set.
  spinFrames: ["◐", "◓", "◑", "◒"] as readonly string[],
} as const;

/** Ordering survives 256-/16-color quantization — canvas always darker than sel. */
export const SURFACE = {
  canvas: "#070a10",
  shell: "#0b1019",
  card: "#101721",
  elev: "#161f2c",
  sel: "#1a2433",
  line: "#1c2433",
  lineSoft: "#141b27",
} as const;

export const FG = {
  strong: "#e6edf6",
  default: "#cbd5e1",
  dim: "#94a3b8",
  faint: "#64748b",
  ghost: "#475569",
} as const;

export function gradientCells(
  width: number,
  glyph: string = GLYPH.block,
): Array<{ ch: string; color: string }> {
  const cells: Array<{ ch: string; color: string }> = [];
  if (width <= 0) return cells;
  const last = GRADIENT.length - 1;
  for (let i = 0; i < width; i++) {
    const t = width === 1 ? 0 : (i * last) / (width - 1);
    const lo = Math.floor(t);
    const hi = Math.min(last, lo + 1);
    // Pick the closer of the two anchor colors for this cell. Linear
    // hex blending could be fancier but the discrete steps already
    // read as a smooth fade at any reasonable width.
    const color = t - lo < 0.5 ? GRADIENT[lo]! : GRADIENT[hi]!;
    cells.push({ ch: glyph, color });
  }
  return cells;
}

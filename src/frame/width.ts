import stringWidthLib from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Grapheme split — keeps ZWJ emoji + combining marks intact. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/** Clamp into {0,1,2} — Frame grid only knows narrow + wide cells. */
export function graphemeWidth(g: string): 0 | 1 | 2 {
  if (g.length === 0) return 0;
  const w = stringWidthLib(g);
  if (w <= 0) return 0;
  if (w >= 2) return 2;
  return 1;
}

/** Total visual width of a string. Direct passthrough to `string-width`. */
export function stringWidth(s: string): number {
  return stringWidthLib(s);
}

import stringWidthRaw from "string-width";

// Box drawing (U+2500..U+257F) and Block Elements (U+2580..U+259F) render as
// width 1 on every modern terminal — pin both explicitly so the CJK-aware
// `ambiguousIsNarrow:false` mode doesn't double-count borders or block art.
function stringWidth(s: string): number {
  if (s.length === 0) return 0;
  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (code >= 0x2500 && code <= 0x259f) return 1;
  }
  return stringWidthRaw(s, { ambiguousIsNarrow: false });
}
import type { Node as YogaNode } from "yoga-layout";
import type { CharPool } from "../pools/char-pool.js";
import type { HyperlinkPool } from "../pools/hyperlink-pool.js";
import type { AnsiCode, StylePool } from "../pools/style-pool.js";
import { type Cell, CellWidth } from "../screen/cell.js";
import { Screen } from "../screen/screen.js";
import type { BorderStyle } from "./borders.js";
import type { BoxNode, LayoutNode, TextNode } from "./node.js";
import {
  type BuiltTree,
  Direction,
  MeasureMode,
  type NodeMeta,
  buildYogaTree,
} from "./yoga-layout.js";

export interface RenderPools {
  readonly char: CharPool;
  readonly style: StylePool;
  readonly hyperlink: HyperlinkPool;
}

interface RowFragment {
  readonly graphemes: ReadonlyArray<{ glyph: string; width: number }>;
  readonly styleId: number;
  readonly hyperlinkId: number;
  readonly leftPad: number;
}

type LayoutRows = RowFragment[][];

interface Laid {
  rows: LayoutRows;
  width: number;
}

export function renderToScreen(
  node: LayoutNode,
  width: number,
  pools: RenderPools,
  maxHeight?: number,
): Screen {
  const w = Math.max(0, width | 0);
  if (w === 0) return new Screen(0, 0);
  const laid = layout(node, w, pools);
  const cap = maxHeight !== undefined ? Math.max(0, Math.floor(maxHeight)) : laid.rows.length;
  const skip = Math.max(0, laid.rows.length - cap);
  return blitRowSlice(laid.rows, skip, laid.rows.length, w, pools);
}

export interface ViewportSplit {
  readonly screen: Screen;
  readonly skipped: number;
  readonly totalRows: number;
  serializePromoted(fromRow: number, toRow: number): string;
}

export function renderViewport(
  node: LayoutNode,
  width: number,
  pools: RenderPools,
  maxHeight: number,
): ViewportSplit {
  const w = Math.max(0, width | 0);
  if (w === 0) {
    return {
      screen: new Screen(0, 0),
      skipped: 0,
      totalRows: 0,
      serializePromoted: () => "",
    };
  }
  const laid = layout(node, w, pools);
  const cap = Math.max(0, Math.floor(maxHeight));
  const skipped = Math.max(0, laid.rows.length - cap);
  const screen = blitRowSlice(laid.rows, skipped, laid.rows.length, w, pools);
  return {
    screen,
    skipped,
    totalRows: laid.rows.length,
    serializePromoted: (fromRow, toRow) =>
      serializeRowSlice(
        laid.rows,
        Math.max(0, fromRow),
        Math.min(toRow, laid.rows.length),
        w,
        pools,
      ),
  };
}

function blitRowSlice(
  rows: LayoutRows,
  fromRow: number,
  toRow: number,
  width: number,
  pools: RenderPools,
): Screen {
  const h = Math.max(0, toRow - fromRow);
  const screen = new Screen(width, h);
  for (let y = 0; y < h; y++) {
    for (const frag of rows[y + fromRow]!) blitFragment(screen, frag, y, pools);
  }
  screen.resetDamage();
  return screen;
}

export interface VirtualLayout {
  readonly totalRows: number;
  windowAt(scrollOffset: number, windowHeight: number): Screen;
}

export function renderVirtual(node: LayoutNode, width: number, pools: RenderPools): VirtualLayout {
  const w = Math.max(0, width | 0);
  if (w === 0) {
    return {
      totalRows: 0,
      windowAt: () => new Screen(0, 0),
    };
  }
  const laid = layout(node, w, pools);
  return {
    totalRows: laid.rows.length,
    windowAt(scrollOffset, windowHeight) {
      const start = Math.max(0, Math.min(laid.rows.length, Math.floor(scrollOffset)));
      const end = Math.max(start, Math.min(laid.rows.length, start + Math.floor(windowHeight)));
      return blitRowSlice(laid.rows, start, end, w, pools);
    },
  };
}

function serializeRowSlice(
  rows: LayoutRows,
  fromRow: number,
  toRow: number,
  width: number,
  pools: RenderPools,
): string {
  if (toRow <= fromRow) return "";
  const screen = blitRowSlice(rows, fromRow, toRow, width, pools);
  let out = "";
  let curStyle = pools.style.none;
  let curLink = 0;
  for (let y = 0; y < screen.height; y++) {
    if (y > 0) {
      out += pools.style.transition(curStyle, pools.style.none);
      curStyle = pools.style.none;
      if (curLink !== 0) {
        out += "\x1b]8;;\x1b\\";
        curLink = 0;
      }
      out += "\r\n";
    }
    for (let x = 0; x < screen.width; x++) {
      const cell = screen.cellAt(x, y);
      if (!cell) continue;
      if (cell.width === CellWidth.SpacerTail) continue;
      if (cell.styleId !== curStyle) {
        out += pools.style.transition(curStyle, cell.styleId);
        curStyle = cell.styleId;
      }
      if (cell.hyperlinkId !== curLink) {
        const uri = pools.hyperlink.get(cell.hyperlinkId) ?? "";
        out += `\x1b]8;;${uri}\x1b\\`;
        curLink = cell.hyperlinkId;
      }
      out += pools.char.get(cell.charId);
    }
  }
  out += pools.style.transition(curStyle, pools.style.none);
  if (curLink !== 0) out += "\x1b]8;;\x1b\\";
  out += "\r\n";
  return out;
}

function layout(node: LayoutNode, availableWidth: number, pools: RenderPools): Laid {
  if (availableWidth <= 0) return { rows: [], width: 0 };

  const built = buildYogaTree(node, pools, measureText);
  built.root.calculateLayout(availableWidth, "auto", Direction.LTR);

  // Yoga places the root at (marginLeft, marginTop) via getComputedLeft/Top,
  // and getComputedHeight/Width excludes margins. Total render bounds =
  // top-margin + content + bottom-margin (right-margin similarly for width).
  const rootTop = Math.max(0, Math.round(built.root.getComputedTop()));
  const rootLeft = Math.max(0, Math.round(built.root.getComputedLeft()));
  const innerHeight = Math.max(0, Math.ceil(built.root.getComputedHeight()));
  const innerWidth = Math.max(0, Math.ceil(built.root.getComputedWidth()));
  const bottomMargin = node.kind === "box" ? Math.max(0, node.marginBottom ?? 0) : 0;
  const rightMargin = node.kind === "box" ? Math.max(0, node.marginRight ?? 0) : 0;
  const totalHeight = rootTop + innerHeight + bottomMargin;
  const totalWidth = rootLeft + innerWidth + rightMargin;

  const rows: LayoutRows = [];
  for (let i = 0; i < totalHeight; i++) rows.push([]);

  rasterize(built.root, built, 0, 0, rows, pools);
  built.root.freeRecursive();

  return { rows, width: totalWidth };
}

function rasterize(
  yoga: YogaNode,
  built: BuiltTree,
  parentX: number,
  parentY: number,
  rows: LayoutRows,
  pools: RenderPools,
): void {
  const meta = built.meta.get(yoga);
  if (!meta) return;

  const left = parentX + Math.round(yoga.getComputedLeft());
  const top = parentY + Math.round(yoga.getComputedTop());
  const width = Math.max(0, Math.round(yoga.getComputedWidth()));
  const height = Math.max(0, Math.round(yoga.getComputedHeight()));

  if (meta.node.kind === "text") {
    rasterizeText(meta.node, left, top, width, height, meta.styleId, meta.hyperlinkId, rows);
    return;
  }

  const box = meta.node;
  if (meta.border) {
    paintBorder(meta, box, left, top, width, height, rows, pools);
  }

  const childList = built.children.get(yoga) ?? [];
  for (const child of childList) {
    rasterize(child, built, left, top, rows, pools);
  }
}

function rasterizeText(
  text: TextNode,
  x: number,
  y: number,
  width: number,
  height: number,
  styleId: number,
  hyperlinkId: number,
  rows: LayoutRows,
): void {
  if (width <= 0 || height <= 0 || y < 0) return;
  const segmenter = getSegmenter();
  let lineIdx = 0;
  for (const rawLine of text.content.split("\n")) {
    if (lineIdx >= height) break;
    const wrapped = wrapLine(rawLine, width, segmenter);
    if (wrapped.length === 0) {
      pushFragment(rows, y + lineIdx, { graphemes: [], styleId, hyperlinkId, leftPad: x });
      lineIdx++;
      continue;
    }
    for (const row of wrapped) {
      if (lineIdx >= height) break;
      pushFragment(rows, y + lineIdx, { graphemes: row, styleId, hyperlinkId, leftPad: x });
      lineIdx++;
    }
  }
}

function paintBorder(
  meta: NodeMeta,
  box: BoxNode,
  left: number,
  top: number,
  width: number,
  height: number,
  rows: LayoutRows,
  pools: RenderPools,
): void {
  if (!meta.border || width <= 0 || height <= 0) return;
  const border = meta.border;
  const topColor = pickStyleId(box.borderTopColor ?? box.borderColor, pools);
  const bottomColor = pickStyleId(box.borderBottomColor ?? box.borderColor, pools);
  const leftColor = pickStyleId(box.borderLeftColor ?? box.borderColor, pools);
  const rightColor = pickStyleId(box.borderRightColor ?? box.borderColor, pools);

  if (meta.useTop) {
    paintHorizontalEdge(
      rows,
      top,
      left,
      width,
      border,
      "top",
      meta.useLeft,
      meta.useRight,
      topColor,
    );
  }
  if (meta.useBottom && height > 1) {
    paintHorizontalEdge(
      rows,
      top + height - 1,
      left,
      width,
      border,
      "bottom",
      meta.useLeft,
      meta.useRight,
      bottomColor,
    );
  }
  const innerTop = top + (meta.useTop ? 1 : 0);
  const innerBottom = top + height - (meta.useBottom ? 2 : 1);
  for (let r = innerTop; r <= innerBottom; r++) {
    if (meta.useLeft) {
      pushFragment(rows, r, {
        graphemes: [{ glyph: border.left, width: Math.max(1, stringWidth(border.left)) }],
        styleId: leftColor,
        hyperlinkId: 0,
        leftPad: left,
      });
    }
    if (meta.useRight && width > 1) {
      pushFragment(rows, r, {
        graphemes: [{ glyph: border.right, width: Math.max(1, stringWidth(border.right)) }],
        styleId: rightColor,
        hyperlinkId: 0,
        leftPad: left + width - 1,
      });
    }
  }
}

function paintHorizontalEdge(
  rows: LayoutRows,
  y: number,
  x: number,
  width: number,
  style: BorderStyle,
  side: "top" | "bottom",
  useLeft: boolean,
  useRight: boolean,
  styleId: number,
): void {
  if (width <= 0 || y < 0) return;
  const corners =
    side === "top" ? [style.topLeft, style.topRight] : [style.bottomLeft, style.bottomRight];
  const edge = side === "top" ? style.top : style.bottom;
  const graphemes: Array<{ glyph: string; width: number }> = [];
  for (let i = 0; i < width; i++) {
    let glyph: string;
    if (i === 0 && useLeft) glyph = corners[0]!;
    else if (i === width - 1 && useRight) glyph = corners[1]!;
    else glyph = edge;
    graphemes.push({ glyph, width: Math.max(1, stringWidth(glyph)) });
  }
  pushFragment(rows, y, { graphemes, styleId, hyperlinkId: 0, leftPad: x });
}

function pushFragment(rows: LayoutRows, y: number, frag: RowFragment): void {
  if (y < 0) return;
  while (rows.length <= y) rows.push([]);
  rows[y]!.push(frag);
}

function pickStyleId(color: ReadonlyArray<AnsiCode> | undefined, pools: RenderPools): number {
  return color ? pools.style.intern(color) : pools.style.none;
}

// Yoga measure function for text leaves — must match wrapLine() at rasterization time.
function measureText(
  content: string,
  width: number,
  widthMode: MeasureMode,
): { width: number; height: number } {
  const segmenter = getSegmenter();
  if (widthMode === MeasureMode.Undefined || width < 0) {
    let maxW = 0;
    let lines = 0;
    for (const line of content.split("\n")) {
      lines += 1;
      const w = stringWidth(line);
      if (w > maxW) maxW = w;
    }
    return { width: maxW, height: Math.max(1, lines) };
  }
  let maxW = 0;
  let totalLines = 0;
  for (const rawLine of content.split("\n")) {
    const wrapped = wrapLine(rawLine, Math.floor(width), segmenter);
    if (wrapped.length === 0) {
      totalLines += 1;
      continue;
    }
    totalLines += wrapped.length;
    for (const row of wrapped) {
      let w = 0;
      for (const g of row) w += g.width;
      if (w > maxW) maxW = w;
    }
  }
  return { width: maxW, height: Math.max(1, totalLines) };
}

function wrapLine(
  line: string,
  width: number,
  segmenter: Intl.Segmenter,
): Array<Array<{ glyph: string; width: number }>> {
  if (width <= 0) return [];
  const rows: Array<Array<{ glyph: string; width: number }>> = [];
  let current: Array<{ glyph: string; width: number }> = [];
  let used = 0;
  for (const seg of segmenter.segment(line)) {
    const glyph = seg.segment;
    const gw = Math.max(0, stringWidth(glyph));
    if (gw === 0) continue;
    if (used + gw > width) {
      if (current.length > 0) rows.push(current);
      current = [];
      used = 0;
      if (gw > width) continue;
    }
    current.push({ glyph, width: gw });
    used += gw;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

function blitFragment(screen: Screen, frag: RowFragment, y: number, pools: RenderPools): void {
  let x = frag.leftPad;
  for (const { glyph, width } of frag.graphemes) {
    if (x >= screen.width) break;
    const charId = pools.char.intern(glyph);
    const cell: Cell = {
      charId,
      styleId: frag.styleId,
      hyperlinkId: frag.hyperlinkId,
      width: width === 2 ? CellWidth.Wide : CellWidth.Single,
    };
    screen.writeCell(x, y, cell);
    if (width === 2 && x + 1 < screen.width) {
      screen.writeCell(x + 1, y, {
        charId: 1,
        styleId: frag.styleId,
        hyperlinkId: frag.hyperlinkId,
        width: CellWidth.SpacerTail,
      });
    }
    x += width;
  }
}

let _segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter {
  if (_segmenter) return _segmenter;
  _segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return _segmenter;
}

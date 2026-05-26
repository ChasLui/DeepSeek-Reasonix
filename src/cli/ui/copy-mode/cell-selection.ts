import { graphemeWidth, graphemes, sliceCells, stringWidth } from "../../../frame/width.js";
import type { SnapshotLine } from "./snapshot.js";

export interface CellPoint {
  readonly line: number;
  readonly cell: number;
}

export interface CellSelection {
  readonly anchor: CellPoint;
  readonly focus: CellPoint;
}

export type CellRange = readonly [fromCell: number, toCell: number];

const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u;

export function normalizeCellSelection(selection: CellSelection): readonly [CellPoint, CellPoint] {
  const { anchor, focus } = selection;
  if (anchor.line < focus.line) return [anchor, focus];
  if (anchor.line > focus.line) return [focus, anchor];
  return anchor.cell <= focus.cell ? [anchor, focus] : [focus, anchor];
}

export function cellRangeForLine(
  selection: CellSelection | null,
  lineIdx: number,
  lineText: string,
  maxCells: number,
): CellRange | null {
  if (selection === null) return null;
  const [start, end] = normalizeCellSelection(selection);
  if (lineIdx < start.line || lineIdx > end.line) return null;
  const lineWidth = Math.min(Math.max(0, maxCells), stringWidth(lineText));
  if (lineWidth === 0) return null;
  if (start.line === end.line) {
    const from = clampCell(start.cell, lineWidth);
    const to = clampCell(end.cell + 1, lineWidth);
    return to > from ? [from, to] : null;
  }
  if (lineIdx === start.line) {
    const from = clampCell(start.cell, lineWidth);
    return from < lineWidth ? [from, lineWidth] : null;
  }
  if (lineIdx === end.line) {
    const to = clampCell(end.cell + 1, lineWidth);
    return to > 0 ? [0, to] : null;
  }
  return [0, lineWidth];
}

export function yankCellSelection(
  snapshot: ReadonlyArray<SnapshotLine>,
  selection: CellSelection,
  maxCells: number,
): string {
  const [start, end] = normalizeCellSelection(selection);
  const picks: string[] = [];
  for (let i = start.line; i <= end.line; i++) {
    const line = snapshot[i];
    if (!line || line.kind === "header") continue;
    if (line.kind === "blank") {
      picks.push("");
      continue;
    }
    const range = cellRangeForLine(selection, i, line.text, maxCells);
    picks.push(range === null ? "" : sliceCells(line.text, range[0], range[1]));
  }
  while (picks.length > 0 && picks[picks.length - 1] === "") picks.pop();
  while (picks.length > 0 && picks[0] === "") picks.shift();
  return picks.join("\n");
}

export function cellRangeForWord(
  lineText: string,
  cell: number,
  maxCells: number,
): CellRange | null {
  const visibleWidth = visibleLineWidth(lineText, maxCells);
  if (visibleWidth === 0) return null;
  const segments = visibleGraphemeSegments(lineText, visibleWidth);
  const targetCell = clampCell(cell, visibleWidth - 1);
  const targetIdx = segments.findIndex((seg) => targetCell >= seg.from && targetCell < seg.to);
  if (targetIdx < 0 || !WORD_CHAR.test(segments[targetIdx]!.text)) return null;
  let fromIdx = targetIdx;
  while (fromIdx > 0 && WORD_CHAR.test(segments[fromIdx - 1]!.text)) fromIdx -= 1;
  let toIdx = targetIdx + 1;
  while (toIdx < segments.length && WORD_CHAR.test(segments[toIdx]!.text)) toIdx += 1;
  return [segments[fromIdx]!.from, segments[toIdx - 1]!.to];
}

export function cellRangeForWholeLine(lineText: string, maxCells: number): CellRange | null {
  const visibleWidth = visibleLineWidth(lineText, maxCells);
  return visibleWidth > 0 ? [0, visibleWidth] : null;
}

function clampCell(cell: number, maxCells: number): number {
  return Math.max(0, Math.min(maxCells, cell));
}

function visibleLineWidth(lineText: string, maxCells: number): number {
  return Math.min(Math.max(0, maxCells), stringWidth(lineText));
}

function visibleGraphemeSegments(
  lineText: string,
  visibleWidth: number,
): Array<{ text: string; from: number; to: number }> {
  const segments: Array<{ text: string; from: number; to: number }> = [];
  let cells = 0;
  for (const g of graphemes(lineText)) {
    const width = graphemeWidth(g);
    const from = cells;
    const to = cells + width;
    if (from >= visibleWidth) break;
    if (width > 0 && to <= visibleWidth) segments.push({ text: g, from, to });
    cells = to;
  }
  return segments;
}

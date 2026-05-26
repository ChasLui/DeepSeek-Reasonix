import { Box, type DOMElement, Text, useBoxMetrics, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React as a runtime value
import React, { useEffect, useMemo, useRef, useState } from "react";
import { clipToCells, sliceCells } from "../../../frame/width.js";
import { t } from "../../../i18n/index.js";
import { writeClipboard } from "../clipboard.js";
import { useKeystroke } from "../keystroke-context.js";
import type { Card } from "../state/cards.js";
import type { KeyEvent } from "../stdin-reader.js";
import { FG, TONE } from "../theme/tokens.js";
import {
  type CellPoint,
  type CellRange,
  type CellSelection,
  cellRangeForLine,
  cellRangeForWholeLine,
  cellRangeForWord,
  yankCellSelection,
} from "./cell-selection.js";
import { type SnapshotLine, buildSnapshot, isYankable, yankRange } from "./snapshot.js";

export interface CopyModeProps {
  cards: ReadonlyArray<Card>;
  onClose: (yanked: { size: number; osc52: boolean; filePath: string | null } | null) => void;
  multiClickMs?: number;
}

const CHROME_ROWS = 3;
const BODY_MOUSE_ROW_OFFSET = 2;
const CONTENT_MOUSE_COL_OFFSET = 3;
const MOUSE_RELEASE_FALLBACK_MS = 2000;
const DEFAULT_MULTI_CLICK_MS = 500;

export function CopyMode({ cards, onClose, multiClickMs }: CopyModeProps): React.ReactElement {
  const rootRef = useRef<DOMElement>(null!);
  const rootMetrics = useBoxMetrics(rootRef);
  const snapshot = useMemo(() => buildSnapshot(cards), [cards]);
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 30;
  const termCols = stdout?.columns ?? 80;
  const rootTop = rootMetrics.hasMeasured ? absoluteTop(rootRef.current) : 0;
  const mouseRowOffset = rootTop + BODY_MOUSE_ROW_OFFSET;
  const bodyRows = Math.max(4, termRows - rootTop - CHROME_ROWS);

  const lastYankableIdx = findLastYankable(snapshot);
  const initialCursor = findFirstYankable(snapshot);

  const [cursor, setCursor] = useState(initialCursor);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [cellSelection, setCellSelection] = useState<CellSelection | null>(null);
  const cellSelectionRef = useRef<CellSelection | null>(null);
  const lastClickRef = useRef<{ point: CellPoint; timeMs: number; count: number } | null>(null);
  const lockedSelectionRef = useRef(false);
  const mouseDraggedRef = useRef(false);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const stepDown = (i: number) => stepBy(snapshot, i, +1);
  const stepUp = (i: number) => stepBy(snapshot, i, -1);
  const window = computeWindow(snapshot, cursor, bodyRows);
  const lineRoom = Math.max(1, termCols - 2);
  const clickWindowMs = normalizeMultiClickMs(multiClickMs);

  useEffect(() => () => clearReleaseFallback(), []);

  const yankText = (text: string) => {
    if (text.length === 0) {
      setStatus(t("copyMode.statusEmpty"));
      return;
    }
    const w = writeClipboard(text);
    setStatus(
      w.osc52
        ? t("copyMode.statusYanked", { size: text.length, osc52: "y" })
        : t("copyMode.statusYankedFile", { size: text.length, path: w.filePath ?? "unknown" }),
    );
    setTimeout(() => onClose(w), 600);
  };
  const updateCellSelection = (selection: CellSelection | null) => {
    cellSelectionRef.current = selection;
    setCellSelection(selection);
  };
  const clearReleaseFallback = () => {
    if (releaseTimerRef.current === null) return;
    clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  };
  const finishCellSelection = (selection: CellSelection) => {
    clearReleaseFallback();
    if (!mouseDraggedRef.current) {
      updateCellSelection(null);
      setStatus(t("copyMode.statusCancelled"));
      return;
    }
    yankText(yankCellSelection(snapshot, selection, lineRoom));
  };
  const armReleaseFallback = () => {
    clearReleaseFallback();
    releaseTimerRef.current = setTimeout(() => {
      const selection = cellSelectionRef.current;
      if (selection !== null) finishCellSelection(selection);
    }, MOUSE_RELEASE_FALLBACK_MS);
  };

  useKeystroke((ev) => {
    if (
      ev.escape ||
      (ev.input === "q" && !ev.ctrl && !ev.alt && !ev.super && !ev.hyper && !ev.meta)
    )
      return onClose(null);
    if (ev.mouseClick || ev.mouseDrag || ev.mouseRelease) {
      const point = mouseTarget(ev, snapshot, window.start, bodyRows, lineRoom, mouseRowOffset);
      if (point === null || !isYankable(snapshot[point.line])) return;
      setCursor(point.line);
      if (ev.mouseClick) {
        setAnchor(null);
        const now = performance.now();
        const clickCount = nextClickCount(lastClickRef.current, point, now, clickWindowMs);
        lastClickRef.current = { point, timeMs: now, count: clickCount };
        const multiSelection = multiClickSelection(clickCount, point, snapshot, lineRoom);
        lockedSelectionRef.current = multiSelection !== null;
        mouseDraggedRef.current = multiSelection !== null;
        updateCellSelection(multiSelection ?? { anchor: point, focus: point });
        setStatus(null);
        return;
      }
      if (ev.mouseDrag) {
        const selection = cellSelectionRef.current;
        if (selection === null) return;
        lockedSelectionRef.current = false;
        mouseDraggedRef.current =
          mouseDraggedRef.current || !sameCellPoint(selection.anchor, point);
        updateCellSelection({ ...selection, focus: point });
        armReleaseFallback();
        return;
      }
      const selection = cellSelectionRef.current;
      if (selection === null) return;
      if (lockedSelectionRef.current) {
        lockedSelectionRef.current = false;
        finishCellSelection(selection);
        return;
      }
      const nextSelection = { ...selection, focus: point };
      mouseDraggedRef.current = mouseDraggedRef.current || !sameCellPoint(selection.anchor, point);
      updateCellSelection(nextSelection);
      finishCellSelection(nextSelection);
      return;
    }
    if (ev.input === "j" || ev.downArrow) {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(stepDown(cursor));
    }
    if (ev.input === "k" || ev.upArrow) {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(stepUp(cursor));
    }
    if (ev.pageDown) {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(scrollBy(snapshot, cursor, bodyRows));
    }
    if (ev.pageUp) {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(scrollBy(snapshot, cursor, -bodyRows));
    }
    if (ev.input === "g") {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(initialCursor);
    }
    if (ev.input === "G") {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      return setCursor(lastYankableIdx);
    }
    if (ev.input === "v" || ev.input === "V") {
      clearReleaseFallback();
      lockedSelectionRef.current = false;
      updateCellSelection(null);
      setAnchor((a) => (a === null ? cursor : null));
      return;
    }
    if (ev.input === "y" || ev.return) {
      if (cellSelection !== null)
        return yankText(yankCellSelection(snapshot, cellSelection, lineRoom));
      const from = anchor ?? cursor;
      const to = cursor;
      const text = yankRange(snapshot, from, to).trim();
      yankText(text);
    }
  });

  const selRange =
    anchor === null ? null : ([Math.min(anchor, cursor), Math.max(anchor, cursor)] as const);
  const totalY = countYankable(snapshot);
  const cursorY = countYankableUntil(snapshot, cursor);

  return (
    <Box ref={rootRef} flexDirection="column">
      <Box>
        <Text color={TONE.brand} bold>
          {t("copyMode.title")}
        </Text>
        <Text color={FG.faint}>{`  ${t("copyMode.help")}`}</Text>
      </Box>
      <Box flexDirection="column">
        {snapshot.length === 0 ? (
          <Text color={FG.faint}>{t("copyMode.empty")}</Text>
        ) : (
          window.lines.map((line, i) => {
            const idx = window.start + i;
            const cellRange =
              line.kind === "text"
                ? cellRangeForLine(cellSelection, idx, line.text, lineRoom)
                : null;
            return (
              <CopyLine
                key={`${line.cardId}-${idx}`}
                line={line}
                cols={termCols}
                isCursor={idx === cursor}
                inSelection={
                  cellSelection === null &&
                  selRange !== null &&
                  idx >= selRange[0] &&
                  idx <= selRange[1]
                }
                cellRange={cellRange}
              />
            );
          })
        )}
      </Box>
      <Box>
        <Text color={FG.meta}>
          {t("copyMode.statusBar", {
            cur: cursorY > 0 ? cursorY : 1,
            total: Math.max(1, totalY),
            sel: anchor === null ? "—" : String(rangeYankable(snapshot, anchor, cursor)),
          })}
        </Text>
        {status ? <Text color={TONE.ok}>{`  ${status}`}</Text> : null}
      </Box>
    </Box>
  );
}

function CopyLine({
  line,
  cols,
  isCursor,
  inSelection,
  cellRange,
}: {
  line: SnapshotLine;
  cols: number;
  isCursor: boolean;
  inSelection: boolean;
  cellRange: CellRange | null;
}): React.ReactElement {
  const marker = isCursor ? "▸ " : "  ";
  const room = Math.max(1, cols - 2);
  const display = line.kind === "blank" ? "" : clipToCells(line.text, room);
  if (line.kind === "header") {
    return (
      <Box>
        <Text color={isCursor ? TONE.brand : FG.faint}>{marker}</Text>
        <Text color={FG.meta}>{display}</Text>
      </Box>
    );
  }
  const color = isCursor ? TONE.brand : FG.body;
  if (cellRange !== null) {
    const [from, to] = cellRange;
    const before = sliceCells(line.text, 0, from);
    const selected = sliceCells(line.text, from, to);
    const after = sliceCells(line.text, to, room);
    return (
      <Box>
        <Text color={isCursor ? TONE.brand : FG.faint}>{marker}</Text>
        {before.length > 0 ? <Text color={color}>{before}</Text> : null}
        <Text color={color} inverse>
          {selected.length === 0 ? " " : selected}
        </Text>
        {after.length > 0 ? <Text color={color}>{after}</Text> : null}
      </Box>
    );
  }
  return (
    <Box>
      <Text color={isCursor ? TONE.brand : FG.faint}>{marker}</Text>
      <Text color={color} inverse={inSelection}>
        {display.length === 0 ? " " : display}
      </Text>
    </Box>
  );
}

function mouseTarget(
  ev: KeyEvent,
  snapshot: ReadonlyArray<SnapshotLine>,
  windowStart: number,
  bodyRows: number,
  lineRoom: number,
  mouseRowOffset: number,
): CellPoint | null {
  if (ev.mouseRow === undefined || ev.mouseCol === undefined || snapshot.length === 0) return null;
  const bodyRow = ev.mouseRow - mouseRowOffset;
  if (bodyRow < 0 || bodyRow >= bodyRows) return null;
  const line = Math.max(0, Math.min(snapshot.length - 1, windowStart + bodyRow));
  const cell = Math.max(0, Math.min(lineRoom - 1, ev.mouseCol - CONTENT_MOUSE_COL_OFFSET));
  return { line, cell };
}

function absoluteTop(node: DOMElement | null): number {
  let top = 0;
  let cur = node;
  while (cur) {
    top += cur.yogaNode?.getComputedLayout().top ?? 0;
    cur = cur.parentNode ?? null;
  }
  return top;
}

function nextClickCount(
  prev: { point: CellPoint; timeMs: number; count: number } | null,
  point: CellPoint,
  nowMs: number,
  windowMs: number,
): number {
  if (prev === null) return 1;
  if (!sameCellPoint(prev.point, point)) return 1;
  if (nowMs - prev.timeMs > windowMs) return 1;
  return Math.min(3, prev.count + 1);
}

function multiClickSelection(
  clickCount: number,
  point: CellPoint,
  snapshot: ReadonlyArray<SnapshotLine>,
  lineRoom: number,
): CellSelection | null {
  const line = snapshot[point.line];
  if (line?.kind !== "text") return null;
  const range =
    clickCount >= 3
      ? cellRangeForWholeLine(line.text, lineRoom)
      : clickCount === 2
        ? cellRangeForWord(line.text, point.cell, lineRoom)
        : null;
  if (range === null) return null;
  return rangeToSelection(point.line, range);
}

function rangeToSelection(line: number, [from, to]: CellRange): CellSelection {
  return {
    anchor: { line, cell: from },
    focus: { line, cell: Math.max(from, to - 1) },
  };
}

function normalizeMultiClickMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return DEFAULT_MULTI_CLICK_MS;
  return Math.max(100, Math.min(2000, value));
}

function sameCellPoint(a: CellPoint, b: CellPoint): boolean {
  return a.line === b.line && a.cell === b.cell;
}

function findFirstYankable(snapshot: ReadonlyArray<SnapshotLine>): number {
  for (let i = 0; i < snapshot.length; i++) if (isYankable(snapshot[i])) return i;
  return 0;
}

function findLastYankable(snapshot: ReadonlyArray<SnapshotLine>): number {
  for (let i = snapshot.length - 1; i >= 0; i--) if (isYankable(snapshot[i])) return i;
  return Math.max(0, snapshot.length - 1);
}

function stepBy(snapshot: ReadonlyArray<SnapshotLine>, from: number, dir: 1 | -1): number {
  const last = snapshot.length - 1;
  let i = Math.max(0, Math.min(last, from + dir));
  while (i > 0 && i < last && snapshot[i]?.kind === "header") i += dir;
  if (i < 0) return 0;
  if (i > last) return last;
  return i;
}

function scrollBy(snapshot: ReadonlyArray<SnapshotLine>, from: number, delta: number): number {
  const last = snapshot.length - 1;
  return Math.max(0, Math.min(last, from + delta));
}

function computeWindow(
  snapshot: ReadonlyArray<SnapshotLine>,
  cursor: number,
  rows: number,
): { start: number; lines: SnapshotLine[] } {
  if (snapshot.length <= rows) return { start: 0, lines: snapshot.slice() };
  const half = Math.floor(rows / 2);
  let start = Math.max(0, cursor - half);
  if (start + rows > snapshot.length) start = snapshot.length - rows;
  return { start, lines: snapshot.slice(start, start + rows) };
}

function countYankable(snapshot: ReadonlyArray<SnapshotLine>): number {
  let n = 0;
  for (const line of snapshot) if (isYankable(line)) n++;
  return n;
}

function countYankableUntil(snapshot: ReadonlyArray<SnapshotLine>, idx: number): number {
  let n = 0;
  for (let i = 0; i <= Math.min(idx, snapshot.length - 1); i++) if (isYankable(snapshot[i])) n++;
  return n;
}

function rangeYankable(snapshot: ReadonlyArray<SnapshotLine>, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let n = 0;
  for (let i = lo; i <= hi; i++) if (isYankable(snapshot[i])) n++;
  return n;
}

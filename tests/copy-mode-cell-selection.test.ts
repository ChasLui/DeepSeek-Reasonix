import { describe, expect, it } from "vitest";
import {
  type CellSelection,
  cellRangeForLine,
  cellRangeForWholeLine,
  cellRangeForWord,
  normalizeCellSelection,
  yankCellSelection,
} from "../src/cli/ui/copy-mode/cell-selection.js";
import type { SnapshotLine } from "../src/cli/ui/copy-mode/snapshot.js";

const line = (text: string, kind: SnapshotLine["kind"] = "text"): SnapshotLine => ({
  cardId: "c1",
  kind,
  role: "assistant",
  text,
});

describe("copy-mode cell selection", () => {
  it("normalizes reversed selections", () => {
    const selection: CellSelection = {
      anchor: { line: 3, cell: 2 },
      focus: { line: 1, cell: 4 },
    };
    expect(normalizeCellSelection(selection)).toEqual([
      { line: 1, cell: 4 },
      { line: 3, cell: 2 },
    ]);
  });

  it("returns an inclusive focus cell range for a single line", () => {
    const selection: CellSelection = {
      anchor: { line: 0, cell: 1 },
      focus: { line: 0, cell: 3 },
    };
    expect(cellRangeForLine(selection, 0, "abcdef", 80)).toEqual([1, 4]);
  });

  it("computes edge and middle ranges for multi-line selections", () => {
    const selection: CellSelection = {
      anchor: { line: 0, cell: 2 },
      focus: { line: 2, cell: 1 },
    };
    expect(cellRangeForLine(selection, 0, "abcdef", 80)).toEqual([2, 6]);
    expect(cellRangeForLine(selection, 1, "middle", 80)).toEqual([0, 6]);
    expect(cellRangeForLine(selection, 2, "tail", 80)).toEqual([0, 2]);
  });

  it("yanks character spans across snapshot lines while skipping headers", () => {
    const snapshot = [line("─── assistant ───", "header"), line("alpha"), line("bravo")];
    const selection: CellSelection = {
      anchor: { line: 1, cell: 1 },
      focus: { line: 2, cell: 2 },
    };
    expect(yankCellSelection(snapshot, selection, 80)).toBe("lpha\nbra");
  });

  it("handles CJK and emoji without splitting graphemes", () => {
    const snapshot = [line("a你好b"), line("x👨‍👩‍👧y")];
    expect(
      yankCellSelection(
        snapshot,
        {
          anchor: { line: 0, cell: 1 },
          focus: { line: 1, cell: 2 },
        },
        80,
      ),
    ).toBe("你好b\nx👨‍👩‍👧");
  });

  it("computes double-click word ranges for paths and CJK", () => {
    expect(cellRangeForWord("/usr/bin/foo bar", 2, 80)).toEqual([0, 12]);
    expect(cellRangeForWord("你好 world", 1, 80)).toEqual([0, 4]);
    expect(cellRangeForWord("foo bar", 4, 80)).toEqual([4, 7]);
  });

  it("returns the visible whole line range for triple-click", () => {
    expect(cellRangeForWholeLine("/usr/bin/foo bar", 80)).toEqual([0, 16]);
    expect(cellRangeForWholeLine("/usr/bin/foo bar", 8)).toEqual([0, 8]);
  });
});

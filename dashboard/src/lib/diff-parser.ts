export type HunkLineType = "add" | "del" | "ctx";

export interface HunkLine {
  type: HunkLineType;
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

/** Parse a unified diff patch string into structured hunk arrays. No external deps. */
export function parseHunks(patch: string): Hunk[] {
  if (!patch) return [];

  const hunks: Hunk[] = [];
  const rawLines = patch.split("\n");
  let cursor = 0;

  // Skip file headers (--- a/..., +++ b/...)
  while (cursor < rawLines.length) {
    const line = rawLines[cursor]!;

    // Start of a hunk: @@ -oldStart[,oldLines] +newStart[,newLines] @@
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const oldStart = parseInt(m[1]!, 10);
      const oldLen = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3]!, 10);
      const newLen = m[4] !== undefined ? parseInt(m[4], 10) : 1;

      const lines: HunkLine[] = [];
      let oldNum = oldStart;
      let newNum = newStart;

      cursor++;
      while (
        cursor < rawLines.length &&
        !rawLines[cursor]!.startsWith("@@ ") &&
        !rawLines[cursor]!.startsWith("diff ") &&
        !rawLines[cursor]!.startsWith("--- ") &&
        !rawLines[cursor]!.startsWith("index ")
      ) {
        const l = rawLines[cursor]!;
        if (l.startsWith("\\")) {
          cursor++;
          continue;
        }

        const ch = l[0]!;
        const content = l.slice(1);

        if (ch === "-") {
          lines.push({ type: "del", content, oldLineNum: oldNum });
          oldNum++;
        } else if (ch === "+") {
          lines.push({ type: "add", content, newLineNum: newNum });
          newNum++;
        } else {
          lines.push({ type: "ctx", content, oldLineNum: oldNum, newLineNum: newNum });
          oldNum++;
          newNum++;
        }
        cursor++;
      }

      hunks.push({ oldStart, oldLines: oldLen, newStart, newLines: newLen, lines });
    } else {
      cursor++;
    }
  }

  return hunks;
}

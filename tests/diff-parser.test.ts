import { describe, expect, it } from "vitest";
import { parseHunks } from "../dashboard/src/lib/diff-parser.js";

describe("parseHunks", () => {
  it("parses a simple modified patch", () => {
    // prettier-ignore
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+modified2",
      "+newline",
      " line3",
    ].join("\n");
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[0]!.oldLines).toBe(3);
    expect(hunks[0]!.newStart).toBe(1);
    expect(hunks[0]!.newLines).toBe(4);
    expect(hunks[0]!.lines).toHaveLength(5);
    expect(hunks[0]!.lines[0]!.type).toBe("ctx");
    expect(hunks[0]!.lines[0]!.content).toBe("line1");
    expect(hunks[0]!.lines[1]!.type).toBe("del");
    expect(hunks[0]!.lines[1]!.content).toBe("line2");
    expect(hunks[0]!.lines[2]!.type).toBe("add");
    expect(hunks[0]!.lines[2]!.content).toBe("modified2");
    expect(hunks[0]!.lines[3]!.type).toBe("add");
    expect(hunks[0]!.lines[3]!.content).toBe("newline");
    expect(hunks[0]!.lines[4]!.type).toBe("ctx");
    expect(hunks[0]!.lines[4]!.content).toBe("line3");
  });

  it("parses multiple hunks", () => {
    // prettier-ignore
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      "@@ -5,3 +5,4 @@",
      " keep",
      "-remove",
      "+added",
      " stay",
    ].join("\n");
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.oldLines).toBe(2);
    expect(hunks[0]!.newLines).toBe(2);
    expect(hunks[1]!.oldLines).toBe(3);
    expect(hunks[1]!.newLines).toBe(4);
  });

  it("parses deleted file patch", () => {
    // prettier-ignore
    const patch = ["--- a/a.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-gone1", "-gone2"].join(
      "\n",
    );
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[0]!.oldLines).toBe(2);
    expect(hunks[0]!.newLines).toBe(0);
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[0]!.lines[0]!.type).toBe("del");
    expect(hunks[0]!.lines[0]!.content).toBe("gone1");
    expect(hunks[0]!.lines[1]!.type).toBe("del");
    expect(hunks[0]!.lines[1]!.content).toBe("gone2");
  });

  it("parses added file patch", () => {
    // prettier-ignore
    const patch = ["--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+new1", "+new2"].join("\n");
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldStart).toBe(0);
    expect(hunks[0]!.oldLines).toBe(0);
    expect(hunks[0]!.newLines).toBe(2);
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[0]!.lines[0]!.type).toBe("add");
    expect(hunks[0]!.lines[0]!.content).toBe("new1");
    expect(hunks[0]!.lines[1]!.type).toBe("add");
    expect(hunks[0]!.lines[1]!.content).toBe("new2");
  });

  it("returns empty array for empty input", () => {
    expect(parseHunks("")).toHaveLength(0);
    expect(parseHunks("not a diff")).toHaveLength(0);
  });

  it("handles no-newline marker", () => {
    // prettier-ignore
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    // \\ markers should be skipped
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[0]!.lines[0]!.type).toBe("del");
    expect(hunks[0]!.lines[0]!.content).toBe("old");
    expect(hunks[0]!.lines[1]!.type).toBe("add");
    expect(hunks[0]!.lines[1]!.content).toBe("new");
  });

  it("populates old/new line numbers", () => {
    // prettier-ignore
    const patch = ["--- a/x", "+++ b/x", "@@ -2,1 +3,1 @@", "-d", "+e"].join("\n");
    const hunks = parseHunks(patch);
    expect(hunks[0]!.lines[0]!.oldLineNum).toBe(2);
    expect(hunks[0]!.lines[0]!.type).toBe("del");
    expect(hunks[0]!.lines[1]!.newLineNum).toBe(3);
    expect(hunks[0]!.lines[1]!.type).toBe("add");
  });
});

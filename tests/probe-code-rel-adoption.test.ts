import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeJsonlText,
  analyzeSessions,
  decideAdoption,
  gateExitCode,
  wilsonInterval,
} from "../scripts/probe-code-rel-adoption.mts";

describe("probe-code-rel-adoption", () => {
  it("counts target tool calls from assistant messages", () => {
    const text = [
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          { function: { name: "find_references" } },
          { function: { name: "read_file" } },
          { function: { name: "impact" } },
        ],
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "detect_changes" }],
      }),
    ].join("\n");

    const result = analyzeJsonlText(text, "messages");

    expect(result.totalToolCalls).toBe(4);
    expect(result.targetToolCalls).toBe(3);
    expect(result.targetCounts).toEqual({
      find_references: 1,
      detect_changes: 1,
      impact: 1,
    });
  });

  it("counts only actual tool.call events in event logs", () => {
    const text = [
      JSON.stringify({ type: "tool.intent", name: "find_references" }),
      JSON.stringify({ type: "tool.call", name: "find_references" }),
      JSON.stringify({ type: "tool.call", name: "search_content" }),
      "{",
    ].join("\n");

    const result = analyzeJsonlText(text, "events");

    expect(result.totalToolCalls).toBe(2);
    expect(result.targetToolCalls).toBe(1);
    expect(result.parseErrors).toBe(1);
  });

  it("keeps Slice 0 decision thresholds explicit", () => {
    expect(decideAdoption(29, 30, 1)).toBe("DATA_INSUFFICIENT");
    expect(decideAdoption(30, 30, 0.049)).toBe("ABANDON");
    expect(decideAdoption(30, 30, 0.05)).toBe("CONDITIONAL");
    expect(decideAdoption(30, 30, 0.2)).toBe("GO");
  });

  it("fails the implementation gate unless adoption is conditional or go", () => {
    expect(gateExitCode("DATA_INSUFFICIENT")).toBe(2);
    expect(gateExitCode("ABANDON")).toBe(2);
    expect(gateExitCode("CONDITIONAL")).toBe(0);
    expect(gateExitCode("GO")).toBe(0);
  });

  it("returns a bounded Wilson interval", () => {
    const interval = wilsonInterval(3, 10);

    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(interval.low).toBeLessThan(interval.high);
  });

  it("does not count empty session files toward the Slice 0 gate", () => {
    const dir = mkdtempFixture();
    try {
      writeFileSync(join(dir, "empty.jsonl"), "", "utf8");
      writeFileSync(
        join(dir, "active.jsonl"),
        `${JSON.stringify({ role: "assistant", tool_calls: [{ function: { name: "read_file" } }] })}\n`,
        "utf8",
      );

      const result = analyzeSessions({
        dir,
        source: "messages",
        minSessions: 2,
        includeSubagents: false,
      });

      expect(result.filesScanned).toBe(2);
      expect(result.usableSessionFiles).toBe(1);
      expect(result.skippedEmptyFiles).toBe(1);
      expect(result.filesWithToolCalls).toBe(1);
      expect(result.oldestUsableSessionMtime).toBe(result.newestUsableSessionMtime);
      expect(result.usableWindowDays).toBe(0);
      expect(result.decision).toBe("DATA_INSUFFICIENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count unparseable session files toward the Slice 0 gate", () => {
    const dir = mkdtempFixture();
    try {
      writeFileSync(join(dir, "bad.jsonl"), "{\n", "utf8");
      writeFileSync(
        join(dir, "active.jsonl"),
        `${JSON.stringify({ role: "assistant", tool_calls: [{ function: { name: "read_file" } }] })}\n`,
        "utf8",
      );

      const result = analyzeSessions({
        dir,
        source: "messages",
        minSessions: 2,
        includeSubagents: false,
      });

      expect(result.filesScanned).toBe(2);
      expect(result.usableSessionFiles).toBe(1);
      expect(result.skippedUnparseableFiles).toBe(1);
      expect(result.parseErrors).toBe(1);
      expect(result.parseableJsonLines).toBe(1);
      expect(result.decision).toBe("DATA_INSUFFICIENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mkdtempFixture(): string {
  const root = join(tmpdir(), "reasonix-code-rel-adoption-");
  const dir = `${root}${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

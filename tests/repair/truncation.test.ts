import { describe, expect, it } from "vitest";
import { repairTruncatedJson } from "../../src/repair/truncation.js";

describe("repairTruncatedJson", () => {
  it("returns parseable JSON unchanged", () => {
    const r = repairTruncatedJson('{"a":1}');
    expect(r.changed).toBe(false);
    expect(r.repaired).toBe('{"a":1}');
  });

  it("closes unbalanced braces", () => {
    const r = repairTruncatedJson('{"a":1');
    expect(r.changed).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes nested unbalanced structures", () => {
    const r = repairTruncatedJson('{"a":{"b":[1,2');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes unterminated string", () => {
    const r = repairTruncatedJson('{"a":"he');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired).a.startsWith("he")).toBe(true);
  });

  it("fills dangling key with null", () => {
    const r = repairTruncatedJson('{"a":');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: null });
  });

  it("handles empty input", () => {
    const r = repairTruncatedJson("");
    expect(r.repaired).toBe("{}");
  });

  it("drops trailing comma", () => {
    const r = repairTruncatedJson('{"a":1,');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: 1 });
  });

  it("jsonrepair fallback rescues smart-quoted truncated JSON (Task 5)", () => {
    const r = repairTruncatedJson("{“a”: “he");
    expect(r.fallback).toBe(false);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: "he" });
    expect(r.notes.some((n) => n.includes("jsonrepair"))).toBe(true);
  });

  it("jsonrepair fallback rescues mixed trailing-comma + unterminated string", () => {
    const r = repairTruncatedJson('{"a": [1, 2, 3,], "b": "hel');
    expect(r.fallback).toBe(false);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    const parsed = JSON.parse(r.repaired);
    expect(parsed.a).toEqual([1, 2, 3]);
    expect(typeof parsed.b).toBe("string");
  });
});

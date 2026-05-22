import { describe, expect, it } from "vitest";
import { tryParseLoose } from "../../src/repair/json-coerce.js";

describe("tryParseLoose", () => {
  it("passes legal JSON through with repaired:false", () => {
    const r = tryParseLoose('{"a":1,"b":"c"}');
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(false);
    expect(r!.value).toEqual({ a: 1, b: "c" });
  });

  it("repairs single-quoted object", () => {
    const r = tryParseLoose("{a: 'b', c: 1}");
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(true);
    expect(r!.value).toEqual({ a: "b", c: 1 });
  });

  it("repairs Python constants True / False / None", () => {
    const r = tryParseLoose('{"a": True, "b": False, "c": None}');
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(true);
    expect(r!.value).toEqual({ a: true, b: false, c: null });
  });

  it("strips trailing commas", () => {
    const r = tryParseLoose('{"a":1,"b":2,}');
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(true);
    expect(r!.value).toEqual({ a: 1, b: 2 });
  });

  it("closes a missing right brace", () => {
    const r = tryParseLoose('{"a":1');
    expect(r).not.toBeNull();
    expect(r!.value).toEqual({ a: 1 });
  });

  it("unwraps fenced code block ```json …```", () => {
    const r = tryParseLoose('```json\n{"a":1}\n```');
    expect(r).not.toBeNull();
    expect(r!.value).toEqual({ a: 1 });
  });

  it("coerces unquoted text into a JSON string (jsonrepair is permissive)", () => {
    // jsonrepair treats bare words as a string. Document the behaviour so
    // callers know not to rely on tryParseLoose for "is this even JSON-like".
    const r = tryParseLoose("hello world");
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(true);
    expect(r!.value).toBe("hello world");
  });

  it("returns null for empty input", () => {
    expect(tryParseLoose("")).toBeNull();
  });
});

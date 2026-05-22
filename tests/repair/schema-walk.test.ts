import { describe, expect, it } from "vitest";
import { formatIssues, validate } from "../../src/repair/schema-walk.js";

describe("validate", () => {
  it("reports required-missing at top level", () => {
    const issues = validate(
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      {},
    );
    expect(issues).toEqual([
      {
        path: ["path"],
        code: "required-missing",
        expected: "string",
        received: "undefined",
      },
    ]);
  });

  it("reports type-mismatch for primitive fields", () => {
    const issues = validate(
      { type: "object", properties: { count: { type: "integer" } } },
      { count: "5" },
    );
    expect(issues).toEqual([
      {
        path: ["count"],
        code: "type-mismatch",
        expected: "integer",
        received: "string",
      },
    ]);
  });

  it("reports array-expected when scalar passed for array field", () => {
    const issues = validate(
      {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      },
      { tags: "foo" },
    );
    expect(issues).toEqual([
      {
        path: ["tags"],
        code: "array-expected",
        expected: "array",
        received: "string",
      },
    ]);
  });

  it("walks into array items", () => {
    const issues = validate(
      {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      },
      { edits: [{ path: "a.ts" }, { other: 1 }] },
    );
    expect(issues).toEqual([
      {
        path: ["edits", "1", "path"],
        code: "required-missing",
        expected: "string",
        received: "undefined",
      },
    ]);
  });

  it("treats explicit null as type-mismatch (not missing)", () => {
    const issues = validate(
      { type: "object", properties: { tag: { type: "string" } } },
      { tag: null },
    );
    expect(issues).toEqual([
      {
        path: ["tag"],
        code: "type-mismatch",
        expected: "string",
        received: "null",
      },
    ]);
  });

  it("returns no issues for a valid args object", () => {
    const issues = validate(
      {
        type: "object",
        properties: { path: { type: "string" }, depth: { type: "integer" } },
        required: ["path"],
      },
      { path: "a.ts", depth: 2 },
    );
    expect(issues).toEqual([]);
  });

  it("reports enum violations (P1 #3)", () => {
    const issues = validate(
      {
        type: "object",
        properties: {
          risk: { type: "string", enum: ["low", "med", "high"] },
        },
      },
      { risk: "critical" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("type-mismatch");
    expect(issues[0]?.expected).toBe('one of: "low"|"med"|"high"');
    expect(issues[0]?.received).toBe('"critical"');
  });

  it("accepts enum members of the correct value", () => {
    const issues = validate(
      {
        type: "object",
        properties: {
          risk: { type: "string", enum: ["low", "med", "high"] },
        },
      },
      { risk: "high" },
    );
    expect(issues).toEqual([]);
  });

  it('handles type as an array (P2 #7) — type: ["string", "null"]', () => {
    const schema = {
      type: "object",
      properties: {
        tag: { type: ["string", "null"] as unknown as string },
      },
    };
    expect(validate(schema, { tag: "hi" })).toEqual([]);
    expect(validate(schema, { tag: null })).toEqual([]);
    expect(validate(schema, { tag: 5 })).toEqual([
      {
        path: ["tag"],
        code: "type-mismatch",
        expected: "string|null",
        received: "number",
      },
    ]);
  });

  it("formats issues for human/model display with json-path-like notation", () => {
    const out = formatIssues([
      {
        path: ["edits", "1", "path"],
        code: "required-missing",
        expected: "string",
        received: "undefined",
      },
      {
        path: ["tags"],
        code: "array-expected",
        expected: "array",
        received: "string",
      },
    ]);
    expect(out).toBe(
      "  - edits[1].path: expected string, got undefined\n  - tags: expected array, got string",
    );
  });
});

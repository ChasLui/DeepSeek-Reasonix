import { describe, expect, it } from "vitest";
import {
  SHAPE_REPAIRS,
  coerceNumericString,
  isRequiredAt,
  parseStringifiedArray,
  stripNullOnOptional,
  unwrapDegenerateAutolinks,
  unwrapEmptyPlaceholderObject,
  wrapBareString,
} from "../../src/repair/arg-shape.js";
import type { Issue } from "../../src/repair/schema-walk.js";

function issue(path: string[], code: Issue["code"], expected: string, received: string): Issue {
  return { path, code, expected, received };
}

const optional = () => false;
const required = () => true;

describe("stripNullOnOptional", () => {
  it("removes null on optional field", () => {
    const args: Record<string, unknown> = { path: "a.ts", tag: null };
    const r = stripNullOnOptional(
      args,
      issue(["tag"], "type-mismatch", "string", "null"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "null-strip" });
    expect(args).toEqual({ path: "a.ts" });
  });

  it("keeps null on required field", () => {
    const args: Record<string, unknown> = { path: null };
    const r = stripNullOnOptional(
      args,
      issue(["path"], "type-mismatch", "string", "null"),
      required,
    );
    expect(r.changed).toBe(false);
    expect(args).toEqual({ path: null });
  });

  it("ignores non-null type mismatch", () => {
    const args: Record<string, unknown> = { count: "5" };
    const r = stripNullOnOptional(
      args,
      issue(["count"], "type-mismatch", "integer", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });

  it("also handles null on an optional array field (issue.code = array-expected)", () => {
    const args: Record<string, unknown> = { path: "a.ts", tags: null };
    const r = stripNullOnOptional(
      args,
      issue(["tags"], "array-expected", "array", "null"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "null-strip" });
    expect(args).toEqual({ path: "a.ts" });
  });
});

describe("parseStringifiedArray", () => {
  it('parses \'["a","b"]\' into ["a","b"]', () => {
    const args: Record<string, unknown> = { tags: '["a","b"]' };
    const r = parseStringifiedArray(
      args,
      issue(["tags"], "array-expected", "array", "string"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "stringified-array-parsed" });
    expect(args.tags).toEqual(["a", "b"]);
  });

  it("ignores strings that aren't bracketed", () => {
    const args: Record<string, unknown> = { tags: "a,b" };
    const r = parseStringifiedArray(
      args,
      issue(["tags"], "array-expected", "array", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });

  it("rejects parsed value that isn't an array (e.g. '[' alone)", () => {
    const args: Record<string, unknown> = { tags: "[}" };
    const r = parseStringifiedArray(
      args,
      issue(["tags"], "array-expected", "array", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });

  it("falls back to jsonrepair for single-quoted array string", () => {
    const args: Record<string, unknown> = { tags: "['a', 'b']" };
    const r = parseStringifiedArray(
      args,
      issue(["tags"], "array-expected", "array", "string"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "stringified-array-parsed" });
    expect(args.tags).toEqual(["a", "b"]);
  });

  it("falls back to jsonrepair for unquoted-string array", () => {
    const args: Record<string, unknown> = { tags: "[foo, bar]" };
    const r = parseStringifiedArray(
      args,
      issue(["tags"], "array-expected", "array", "string"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "stringified-array-parsed" });
    expect(args.tags).toEqual(["foo", "bar"]);
  });
});

describe("unwrapEmptyPlaceholderObject", () => {
  it("turns {} into [] at the array field", () => {
    const args: Record<string, unknown> = { tags: {} };
    const r = unwrapEmptyPlaceholderObject(
      args,
      issue(["tags"], "array-expected", "array", "object"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "empty-placeholder-to-array" });
    expect(args.tags).toEqual([]);
  });

  it("ignores non-empty object", () => {
    const args: Record<string, unknown> = { tags: { a: 1 } };
    const r = unwrapEmptyPlaceholderObject(
      args,
      issue(["tags"], "array-expected", "array", "object"),
      optional,
    );
    expect(r.changed).toBe(false);
  });
});

describe("wrapBareString", () => {
  it("wraps a bare string into a single-element array", () => {
    const args: Record<string, unknown> = { tags: "foo" };
    const r = wrapBareString(args, issue(["tags"], "array-expected", "array", "string"), optional);
    expect(r).toEqual({ changed: true, kind: "bare-string-wrapped" });
    expect(args.tags).toEqual(["foo"]);
  });

  it("does not run when value already an array", () => {
    const args: Record<string, unknown> = { tags: ["foo"] };
    const r = wrapBareString(args, issue(["tags"], "array-expected", "array", "array"), optional);
    expect(r.changed).toBe(false);
  });
});

describe("SHAPE_REPAIRS ordering", () => {
  it('json-array-parse runs before bare-string-wrap so \'["a","b"]\' becomes ["a","b"], not [\'["a","b"]\']', () => {
    const args: Record<string, unknown> = { tags: '["a","b"]' };
    const tagsIssue = issue(["tags"], "array-expected", "array", "string");
    let applied = false;
    for (const repair of SHAPE_REPAIRS) {
      const r = repair(args, tagsIssue, optional);
      if (r.changed) {
        applied = true;
        break;
      }
    }
    expect(applied).toBe(true);
    expect(args.tags).toEqual(["a", "b"]);
  });
});

describe("stripNullOnOptional — array element guard (P0 #2)", () => {
  it("refuses to splice null out of an array element", () => {
    const args: Record<string, unknown> = {
      edits: [null, { path: "b.ts" }],
    };
    const r = stripNullOnOptional(
      args,
      issue(["edits", "0"], "type-mismatch", "object", "null"),
      optional,
    );
    expect(r.changed).toBe(false);
    expect((args.edits as unknown[]).length).toBe(2);
  });
});

describe("coerceNumericString (P1 #5)", () => {
  it("coerces '50' → 50 on type=integer field", () => {
    const args: Record<string, unknown> = { head: "50" };
    const r = coerceNumericString(
      args,
      issue(["head"], "type-mismatch", "integer", "string"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "numeric-string-coerced" });
    expect(args.head).toBe(50);
  });

  it("coerces '0.5' → 0.5 on type=number field", () => {
    const args: Record<string, unknown> = { weight: "0.5" };
    const r = coerceNumericString(
      args,
      issue(["weight"], "type-mismatch", "number", "string"),
      optional,
    );
    expect(r).toEqual({ changed: true, kind: "numeric-string-coerced" });
    expect(args.weight).toBe(0.5);
  });

  it("refuses '0.5' on integer field", () => {
    const args: Record<string, unknown> = { head: "0.5" };
    const r = coerceNumericString(
      args,
      issue(["head"], "type-mismatch", "integer", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });

  it("refuses non-numeric strings", () => {
    const args: Record<string, unknown> = { head: "abc" };
    const r = coerceNumericString(
      args,
      issue(["head"], "type-mismatch", "integer", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });

  it("ignores boolean / string field type mismatches", () => {
    const args: Record<string, unknown> = { active: "true" };
    const r = coerceNumericString(
      args,
      issue(["active"], "type-mismatch", "boolean", "string"),
      optional,
    );
    expect(r.changed).toBe(false);
  });
});

describe("unwrapDegenerateAutolinks", () => {
  it("unwraps [foo.md](http://foo.md) at a path key", () => {
    const args: Record<string, unknown> = {
      path: "[notes.md](http://notes.md)",
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r).toEqual({ changed: true, unwrapped: 1 });
    expect(args.path).toBe("notes.md");
  });

  it("tolerates whitespace in URL body AND returns whitespace-stripped text (P1 #4)", () => {
    const args: Record<string, unknown> = {
      path: "[src/fo o.ts](http://src/foo.ts)",
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(true);
    expect(args.path).toBe("src/foo.ts");
  });

  it("leaves write_file.content alone even if it matches the degenerate form (P0 #1)", () => {
    const args: Record<string, unknown> = {
      path: "LICENSE.md",
      content: "[LICENSE](http://LICENSE)",
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(false);
    expect(args.content).toBe("[LICENSE](http://LICENSE)");
  });

  it("leaves submit_plan.plan alone (lenient tools, non-path key)", () => {
    const args: Record<string, unknown> = {
      plan: "# Plan\nstep 1: [release](http://release)",
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(false);
  });

  it("leaves real markdown links alone (link text ≠ URL host)", () => {
    const args: Record<string, unknown> = {
      path: "[click](https://example.com)",
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(false);
  });

  it("unwraps inside nested edits[*].path", () => {
    const args: Record<string, unknown> = {
      edits: [{ path: "[a.ts](http://a.ts)", content: "x" }, { path: "b.ts" }],
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r).toEqual({ changed: true, unwrapped: 1 });
    expect((args.edits as Array<{ path: string }>)[0]?.path).toBe("a.ts");
  });

  it("unwraps inside paths array elements (inherits scope from parent key)", () => {
    const args: Record<string, unknown> = {
      paths: ["[a.ts](http://a.ts)", "b.ts"],
    };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(true);
    expect(args.paths).toEqual(["a.ts", "b.ts"]);
  });

  it("no-op for clean inputs", () => {
    const args: Record<string, unknown> = { path: "src/foo.ts" };
    const r = unwrapDegenerateAutolinks(args);
    expect(r.changed).toBe(false);
  });
});

describe("isRequiredAt", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      tag: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" } },
          required: ["file"],
        },
      },
    },
    required: ["path"],
  } as const;

  it("returns true for a top-level required key", () => {
    expect(isRequiredAt(schema, ["path"])).toBe(true);
  });

  it("returns false for an optional key", () => {
    expect(isRequiredAt(schema, ["tag"])).toBe(false);
  });

  it("walks through array items", () => {
    expect(isRequiredAt(schema, ["edits", "0", "file"])).toBe(true);
  });
});

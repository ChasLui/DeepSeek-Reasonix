import type { JSONSchema } from "../types.js";

export type IssueCode = "required-missing" | "type-mismatch" | "array-expected";

export interface Issue {
  path: string[];
  code: IssueCode;
  expected: string;
  received: string;
}

export function validate(schema: JSONSchema | undefined, args: unknown): Issue[] {
  const issues: Issue[] = [];
  walk(schema, args, [], issues);
  return issues;
}

function walk(schema: JSONSchema | undefined, value: unknown, path: string[], out: Issue[]): void {
  if (!schema) return;

  const allowedTypes = normalizeTypes(schema.type);

  if (allowedTypes.includes("array")) {
    if (Array.isArray(value)) {
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          walk(schema.items, value[i], [...path, String(i)], out);
        }
      }
      return;
    }
    if (allowedTypes.length === 1) {
      out.push({
        path,
        code: "array-expected",
        expected: "array",
        received: receivedKind(value),
      });
      return;
    }
  }

  if (allowedTypes.includes("object")) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const required = schema.required ?? [];
      for (const key of required) {
        if (obj[key] === undefined) {
          out.push({
            path: [...path, key],
            code: "required-missing",
            expected: childTypeName(schema, key),
            received: "undefined",
          });
        }
      }
      const props = schema.properties ?? {};
      for (const [key, child] of Object.entries(props)) {
        if (obj[key] === undefined) continue;
        walk(child, obj[key], [...path, key], out);
      }
      return;
    }
    if (allowedTypes.length === 1) {
      out.push({
        path,
        code: "type-mismatch",
        expected: "object",
        received: receivedKind(value),
      });
      return;
    }
  }

  if (allowedTypes.length > 0 && !allowedTypes.some((t) => typeMatches(t, value))) {
    out.push({
      path,
      code: "type-mismatch",
      expected: allowedTypes.length === 1 ? allowedTypes[0]! : allowedTypes.join("|"),
      received: receivedKind(value),
    });
    return;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.includes(value as never)) {
      out.push({
        path,
        code: "type-mismatch",
        expected: `one of: ${schema.enum.map((v) => JSON.stringify(v)).join("|")}`,
        received: JSON.stringify(value),
      });
    }
  }
}

function normalizeTypes(t: unknown): string[] {
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

export function receivedKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function childTypeName(parent: JSONSchema, key: string): string {
  const child = parent.properties?.[key];
  if (child && typeof child.type === "string") return child.type;
  return "value";
}

export function formatIssues(issues: Issue[]): string {
  return issues
    .map((i) => `  - ${pathToString(i.path)}: expected ${i.expected}, got ${i.received}`)
    .join("\n");
}

function pathToString(path: string[]): string {
  if (path.length === 0) return "<root>";
  return path.map((p, idx) => (idx === 0 ? p : /^\d+$/.test(p) ? `[${p}]` : `.${p}`)).join("");
}

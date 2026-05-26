import { tryParseLoose } from "./json-coerce.js";
import type { Issue } from "./schema-walk.js";

export type RepairKind =
  | "null-strip"
  | "stringified-array-parsed"
  | "empty-placeholder-to-array"
  | "bare-string-wrapped"
  | "numeric-string-coerced"
  | "autolink-unwrapped"
  | "jsonrepair-fallback"
  | "unknown-tool-aliased"
  | "unknown-tool-unaliased";

export interface RepairOutcome {
  changed: boolean;
  kind?: RepairKind;
}

export type ShapeRepair = (
  args: Record<string, unknown>,
  issue: Issue,
  isRequired: (path: string[]) => boolean,
) => RepairOutcome;

/** Refuse to strip null at array indices — element drop changes batch semantics; leave it to the tool. */
function lastSegmentIsArrayIndex(path: string[]): boolean {
  const last = path[path.length - 1];
  return typeof last === "string" && /^\d+$/.test(last);
}

export const stripNullOnOptional: ShapeRepair = (args, issue, isRequired) => {
  if (issue.received !== "null") return { changed: false };
  if (lastSegmentIsArrayIndex(issue.path)) return { changed: false };
  if (isRequired(issue.path)) return { changed: false };
  if (!deletePath(args, issue.path)) return { changed: false };
  return { changed: true, kind: "null-strip" };
};

export const coerceNumericString: ShapeRepair = (args, issue) => {
  if (issue.code !== "type-mismatch") return { changed: false };
  if (issue.expected !== "number" && issue.expected !== "integer") return { changed: false };
  const current = getPath(args, issue.path);
  if (typeof current !== "string") return { changed: false };
  const trimmed = current.trim();
  if (trimmed.length === 0) return { changed: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { changed: false };
  if (issue.expected === "integer" && !Number.isInteger(n)) return { changed: false };
  setPath(args, issue.path, n);
  return { changed: true, kind: "numeric-string-coerced" };
};

export const parseStringifiedArray: ShapeRepair = (args, issue) => {
  if (issue.code !== "array-expected") return { changed: false };
  const current = getPath(args, issue.path);
  if (typeof current !== "string") return { changed: false };
  const trimmed = current.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) return { changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const loose = tryParseLoose(trimmed);
    if (!loose) return { changed: false };
    parsed = loose.value;
  }
  if (!Array.isArray(parsed)) return { changed: false };
  setPath(args, issue.path, parsed);
  return { changed: true, kind: "stringified-array-parsed" };
};

export const unwrapEmptyPlaceholderObject: ShapeRepair = (args, issue) => {
  if (issue.code !== "array-expected") return { changed: false };
  const current = getPath(args, issue.path);
  if (!isPlainObject(current)) return { changed: false };
  if (Object.keys(current as Record<string, unknown>).length !== 0) return { changed: false };
  setPath(args, issue.path, []);
  return { changed: true, kind: "empty-placeholder-to-array" };
};

export const wrapBareString: ShapeRepair = (args, issue) => {
  if (issue.code !== "array-expected") return { changed: false };
  const current = getPath(args, issue.path);
  if (typeof current !== "string") return { changed: false };
  setPath(args, issue.path, [current]);
  return { changed: true, kind: "bare-string-wrapped" };
};

export const SHAPE_REPAIRS: readonly ShapeRepair[] = [
  stripNullOnOptional,
  coerceNumericString,
  parseStringifiedArray,
  unwrapEmptyPlaceholderObject,
  wrapBareString,
];

export const PATH_FIELD_NAMES: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "source",
  "destination",
  "file_path",
  "filepath",
  "src",
  "dst",
  "target",
]);

const DEGENERATE_AUTOLINK = /^\[([^\]]+)\]\(https?:\/\/([^)]+)\)$/;

export interface AutolinkSweep {
  changed: boolean;
  unwrapped: number;
}

export function unwrapDegenerateAutolinks(args: unknown): AutolinkSweep {
  let unwrapped = 0;
  visitStringsScoped(args, undefined, (parent, key, value, inPathScope) => {
    if (!inPathScope) return;
    const next = unwrapAutolink(value);
    if (next !== value) {
      if (Array.isArray(parent)) (parent as unknown[])[Number(key)] = next;
      else (parent as Record<string, unknown>)[key as string] = next;
      unwrapped++;
    }
  });
  return { changed: unwrapped > 0, unwrapped };
}

function unwrapAutolink(value: string): string {
  const m = DEGENERATE_AUTOLINK.exec(value);
  if (!m) return value;
  const text = m[1]!;
  const urlBody = m[2]!.replace(/\s+/g, "");
  const textBody = text.replace(/\s+/g, "");
  return textBody === urlBody ? textBody : value;
}

function visitStringsScoped(
  node: unknown,
  parentKey: string | undefined,
  visit: (parent: unknown, key: string | number, value: string, inPathScope: boolean) => void,
): void {
  if (Array.isArray(node)) {
    const inherit = parentKey !== undefined && PATH_FIELD_NAMES.has(parentKey);
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") visit(node, i, v, inherit);
      else if (v && typeof v === "object") visitStringsScoped(v, parentKey, visit);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, v] of Object.entries(node)) {
      if (typeof v === "string") visit(node, key, v, PATH_FIELD_NAMES.has(key));
      else if (v && typeof v === "object") visitStringsScoped(v, key, visit);
    }
  }
}

function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getPath(root: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur)
      ? (cur as unknown[])[Number(seg)]
      : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return;
  let cur: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
    if (cur === null || typeof cur !== "object") return;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else cur[last] = value;
}

function deletePath(root: Record<string, unknown>, path: string[]): boolean {
  if (path.length === 0) return false;
  let cur: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
    if (cur === null || typeof cur !== "object") return false;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) return false;
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

export function isRequiredAt(
  schema: import("../types.js").JSONSchema | undefined,
  path: string[],
): boolean {
  if (!schema || path.length === 0) return false;
  let cur: import("../types.js").JSONSchema | undefined = schema;
  for (let i = 0; i < path.length; i++) {
    if (!cur) return false;
    const seg = path[i]!;
    if (cur.type === "array") {
      cur = cur.items;
      continue;
    }
    const isLast = i === path.length - 1;
    if (isLast) {
      return Boolean(cur.required?.includes(seg));
    }
    cur = cur.properties?.[seg];
  }
  return false;
}

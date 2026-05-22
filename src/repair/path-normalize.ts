import type { ToolCall } from "../types.js";

const CONTAINER_ROOT_RE = /^\/root(?=[/\\]|$)/;

const PATH_KEYS = ["path", "source", "destination", "file_path", "filepath"] as const;

export interface PathNormalizeResult {
  changed: boolean;
  note?: string;
}

export function normalizeContainerPaths(call: ToolCall): PathNormalizeResult {
  const raw = call.function?.arguments ?? "";
  if (!raw || !raw.includes("/root")) return { changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { changed: false };
  }
  if (!parsed || typeof parsed !== "object") return { changed: false };
  const touched = stripFromObject(parsed as Record<string, unknown>);
  if (touched === 0) return { changed: false };
  call.function.arguments = JSON.stringify(parsed);
  const name = call.function?.name ?? "?";
  return {
    changed: true,
    note: `[${name}] stripped /root prefix from ${touched} path arg(s) — DeepSeek container-CWD habit, rerooted under workspace`,
  };
}

function stripFromObject(obj: Record<string, unknown>): number {
  let count = 0;
  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && CONTAINER_ROOT_RE.test(v)) {
      obj[key] = stripPrefix(v);
      count++;
    }
  }
  const edits = obj.edits;
  if (Array.isArray(edits)) {
    for (const item of edits) {
      if (item && typeof item === "object") {
        count += stripFromObject(item as Record<string, unknown>);
      }
    }
  }
  return count;
}

function stripPrefix(p: string): string {
  const next = p.replace(CONTAINER_ROOT_RE, "");
  return next.length === 0 ? "." : next;
}

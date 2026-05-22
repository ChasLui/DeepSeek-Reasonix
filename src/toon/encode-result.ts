import { type ToonMode, resolveToonMode } from "../config.js";
import { encodeToonPayload } from "./codec.js";
import { recordToonEncode, recordToonEncodeFallback } from "./stats.js";
export { TOON_ENCODE_OPTIONS, encodeToonPayload } from "./codec.js";

export interface ToonResultOptions {
  mode?: ToonMode;
}

export function serializeToolResult(value: unknown, opts: ToonResultOptions = {}): string {
  if (!toonResultsEnabled(opts.mode)) return stringifyToolResult(value);
  if (typeof value === "string") return serializeStringResult(value, opts);
  const json = stringifyToolResult(value);
  try {
    const toon = encodeToonPayload(value);
    recordToonEncode("tool-result", json, toon);
    return toon;
  } catch {
    recordToonEncodeFallback();
    return json;
  }
}

export function serializeStringResult(value: string, opts: ToonResultOptions = {}): string {
  if (!toonResultsEnabled(opts.mode)) return value;
  const parsed = tryParseJsonPayload(value);
  if (!parsed.ok) return value;
  try {
    const toon = encodeToonPayload(parsed.value);
    recordToonEncode("tool-result", value, toon);
    return toon;
  } catch {
    recordToonEncodeFallback();
    return value;
  }
}

function toonResultsEnabled(mode: ToonMode | undefined): boolean {
  const resolved = mode ?? resolveToonMode();
  return resolved === "all" || resolved === "results";
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? "null" : json;
}

function tryParseJsonPayload(value: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

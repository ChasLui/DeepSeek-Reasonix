import { type ToonMode, resolveToonMode } from "../config.js";
import { encodeToonPayload } from "./encode-result.js";
import { recordToonEncode, recordToonEncodeFallback } from "./stats.js";

export interface ToonPromptOptions {
  mode?: ToonMode;
}

export function toonPrefixEnabled(mode: ToonMode | undefined): boolean {
  const resolved = mode ?? resolveToonMode();
  return resolved === "all" || resolved === "prefix";
}

export function serializePromptPayload(value: unknown, _opts: ToonPromptOptions = {}): string {
  const json = JSON.stringify(value);
  try {
    const toon = encodeToonPayload(value);
    recordToonEncode("prompt-prefix", json === undefined ? "null" : json, toon);
    return toon;
  } catch (err) {
    recordToonEncodeFallback();
    throw err;
  }
}

export function formatPromptPayloadBlock(value: unknown, opts: ToonPromptOptions = {}): string {
  if (!toonPrefixEnabled(opts.mode)) return "";
  return `\`\`\`toon\n${serializePromptPayload(value, opts)}\n\`\`\``;
}

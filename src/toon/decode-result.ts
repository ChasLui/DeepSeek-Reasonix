import { decodeStructuredPayloadObserved } from "./codec.js";
import { recordToonDecode } from "./stats.js";
export { TOON_DECODE_OPTIONS, decodeStructuredPayload } from "./codec.js";

export function decodeToolResult(value: string): unknown {
  return decodeStructuredPayloadObserved(value, recordToonDecode);
}

export function decodeToolResultObject(value: string): Record<string, unknown> | null {
  if (value.trimStart().startsWith("ERROR:")) return null;
  try {
    const decoded = decodeToolResult(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

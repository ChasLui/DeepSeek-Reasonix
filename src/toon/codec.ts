import { decode, encode } from "@toon-format/toon";

export const TOON_ENCODE_OPTIONS = {
  indent: 2,
  delimiter: "," as const,
  keyFolding: "off" as const,
};

export const TOON_DECODE_OPTIONS = {
  indent: 2,
  strict: true,
  expandPaths: "off" as const,
};

export function encodeToonPayload(value: unknown): string {
  const encoded = encode(value, TOON_ENCODE_OPTIONS);
  if (encoded.trim().length > 0) return encoded;
  return JSON.stringify(value) ?? "null";
}

export type DecodeKind = "json" | "toon" | "failed";

export function decodeStructuredPayload(value: string): unknown {
  return decodeStructuredPayloadObserved(value);
}

export function decodeStructuredPayloadObserved(
  value: string,
  observe?: (kind: DecodeKind) => void,
): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      observe?.("json");
      return parsed;
    } catch {
      try {
        const decoded = decode(trimmed, TOON_DECODE_OPTIONS);
        observe?.("toon");
        return decoded;
      } catch (err) {
        observe?.("failed");
        throw err;
      }
    }
  }
  try {
    const decoded = decode(trimmed, TOON_DECODE_OPTIONS);
    observe?.("toon");
    return decoded;
  } catch {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      observe?.("json");
      return parsed;
    } catch (err) {
      observe?.("failed");
      throw err;
    }
  }
}

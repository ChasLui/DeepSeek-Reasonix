import { countTokensBounded } from "../tokenizer.js";

export type ToonLayer = "tool-result" | "prompt-prefix";

export interface ToonLayerStats {
  hits: number;
  jsonBytes: number;
  toonBytes: number;
  savedBytes: number;
  jsonTokens: number;
  toonTokens: number;
  savedTokens: number;
}

export interface ToonDecodeStats {
  json: number;
  toon: number;
  failed: number;
}

export interface ToonFallbackStats {
  encode: number;
  decode: number;
}

export interface ToonStats {
  layers: Record<ToonLayer, ToonLayerStats>;
  decode: ToonDecodeStats;
  fallbacks: ToonFallbackStats;
}

function emptyLayer(): ToonLayerStats {
  return {
    hits: 0,
    jsonBytes: 0,
    toonBytes: 0,
    savedBytes: 0,
    jsonTokens: 0,
    toonTokens: 0,
    savedTokens: 0,
  };
}

const layers: Record<ToonLayer, ToonLayerStats> = {
  "tool-result": emptyLayer(),
  "prompt-prefix": emptyLayer(),
};

const decode: ToonDecodeStats = { json: 0, toon: 0, failed: 0 };
const fallbacks: ToonFallbackStats = { encode: 0, decode: 0 };

export function resetToonStats(): void {
  layers["tool-result"] = emptyLayer();
  layers["prompt-prefix"] = emptyLayer();
  decode.json = 0;
  decode.toon = 0;
  decode.failed = 0;
  fallbacks.encode = 0;
  fallbacks.decode = 0;
}

export function getToonStats(): ToonStats {
  return {
    layers: {
      "tool-result": { ...layers["tool-result"] },
      "prompt-prefix": { ...layers["prompt-prefix"] },
    },
    decode: { ...decode },
    fallbacks: { ...fallbacks },
  };
}

export function recordToonEncode(layer: ToonLayer, jsonText: string, toonText: string): void {
  const entry = layers[layer];
  const jsonTokens = safeCountTokens(jsonText);
  const toonTokens = safeCountTokens(toonText);
  entry.hits += 1;
  entry.jsonBytes += jsonText.length;
  entry.toonBytes += toonText.length;
  entry.savedBytes += Math.max(0, jsonText.length - toonText.length);
  entry.jsonTokens += jsonTokens;
  entry.toonTokens += toonTokens;
  entry.savedTokens += Math.max(0, jsonTokens - toonTokens);
}

export function recordToonEncodeFallback(): void {
  fallbacks.encode += 1;
}

export function recordToonDecode(kind: "json" | "toon" | "failed"): void {
  decode[kind] += 1;
  if (kind === "failed") fallbacks.decode += 1;
}

function safeCountTokens(text: string): number {
  try {
    return countTokensBounded(text);
  } catch {
    return Math.max(1, Math.ceil(text.length * 0.3));
  }
}

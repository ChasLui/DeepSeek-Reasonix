import { createRequire } from "node:module";

export type TextScript = "latin" | "cjk" | "mixed" | "other";

export interface SegmentOptions {
  loadJieba?: () => unknown;
}

interface JiebaLike {
  cut(input: string): string[];
}

const require = createRequire(import.meta.url);

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_RE = /[A-Za-z0-9]/u;

let cachedJieba: JiebaLike | null | false = null;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function detectScript(text: string): TextScript {
  const hasEastAsian = hasCjk(text);
  const hasLatin = LATIN_RE.test(text);
  if (hasEastAsian && hasLatin) return "mixed";
  if (hasEastAsian) return "cjk";
  if (hasLatin) return "latin";
  return "other";
}

export function segmentCjk(text: string, opts: SegmentOptions = {}): string[] {
  const input = text.trim();
  if (!input) return [];
  if (process.env.REASONIX_CJK_JIEBA === "0") return fallbackSegment(input);

  const jieba = opts.loadJieba ? instantiateJieba(opts.loadJieba) : getCachedJieba();
  if (jieba) {
    try {
      const tokens = cleanTokens(jieba.cut(input));
      if (tokens.length > 0) return tokens;
    } catch {
      return fallbackSegment(input);
    }
  }
  return fallbackSegment(input);
}

function getCachedJieba(): JiebaLike | null {
  if (process.env.REASONIX_CJK_JIEBA === "0") return null;
  if (cachedJieba === false) return null;
  if (cachedJieba) return cachedJieba;
  const loaded = instantiateJieba(() => require("@node-rs/jieba"));
  cachedJieba = loaded ?? false;
  return loaded;
}

function instantiateJieba(load: () => unknown): JiebaLike | null {
  let mod: unknown;
  try {
    mod = load();
  } catch {
    return null;
  }

  try {
    const value = mod as {
      default?: unknown;
      Jieba?: new () => JiebaLike;
      cut?: (input: string) => string[];
    };
    if (typeof value.cut === "function") return { cut: value.cut.bind(value) };
    if (value.default && typeof value.default === "object") {
      const def = value.default as { cut?: (input: string) => string[] };
      if (typeof def.cut === "function") return { cut: def.cut.bind(def) };
    }
    if (typeof value.Jieba === "function") return new value.Jieba();
  } catch {
    return null;
  }
  return null;
}

function fallbackSegment(text: string): string[] {
  const tokens: string[] = [];
  let group = "";
  let groupKind: "cjk" | "latin" | null = null;

  const flush = () => {
    if (!group || !groupKind) return;
    if (groupKind === "latin") tokens.push(group.toLowerCase());
    else tokens.push(...cjkBigrams(group));
    group = "";
    groupKind = null;
  };

  for (const char of text) {
    if (CJK_RE.test(char)) {
      if (groupKind !== "cjk") flush();
      groupKind = "cjk";
      group += char;
    } else if (/[\p{Letter}\p{Number}_-]/u.test(char)) {
      if (groupKind !== "latin") flush();
      groupKind = "latin";
      group += char;
    } else {
      flush();
    }
  }
  flush();

  return cleanTokens(tokens);
}

function cjkBigrams(group: string): string[] {
  const chars = [...group];
  if (chars.length <= 1) return chars;
  const tokens: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) tokens.push(`${chars[i]}${chars[i + 1]}`);
  return tokens;
}

function cleanTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (/^[\p{Punctuation}\p{Separator}\p{Symbol}]+$/u.test(token)) continue;
    out.push(token);
  }
  return out;
}

import { jsonrepair } from "jsonrepair";

export interface LooseParseResult {
  value: unknown;
  /** True when jsonrepair had to rewrite the input; false when strict parse already succeeded. */
  repaired: boolean;
  note?: string;
}

export function tryParseLoose(input: string): LooseParseResult | null {
  if (typeof input !== "string" || input.length === 0) return null;
  try {
    return { value: JSON.parse(input), repaired: false };
  } catch {
    /* fall through */
  }
  let rewritten: string;
  try {
    rewritten = jsonrepair(input);
  } catch (err) {
    return null;
  }
  try {
    return {
      value: JSON.parse(rewritten),
      repaired: true,
      note: "recovered via jsonrepair",
    };
  } catch {
    return null;
  }
}

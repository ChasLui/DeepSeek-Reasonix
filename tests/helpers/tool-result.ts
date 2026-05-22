import { expect } from "vitest";
import { decodeToolResultObject } from "../../src/toon/decode-result.js";

export function parseToolResult<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
): T {
  const decoded = decodeToolResultObject(text);
  expect(decoded).not.toBeNull();
  return (decoded ?? {}) as T;
}

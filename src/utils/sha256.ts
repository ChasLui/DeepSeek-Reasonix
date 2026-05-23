import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Prefix(input: string, length = 16): string {
  return sha256Hex(input).slice(0, length);
}

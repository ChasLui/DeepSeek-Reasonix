/**
 * Bench: MCP response shield — SC-002a-d synthetic fixtures.
 * Run: pnpm bench-shield
 * Not part of CI; dev-local only.
 */

import {
  MAX_ARRAY_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_STRING_LENGTH,
  shieldMcpResult,
} from "../src/mcp/shield.js";
import type { CallToolResult } from "../src/mcp/types.js";

function makeText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function makeJsonText(value: unknown): CallToolResult {
  return makeText(JSON.stringify(value));
}

function byteLen(r: CallToolResult): number {
  return JSON.stringify(r).length;
}

function pct(after: number, before: number): string {
  return `${((after / before) * 100).toFixed(1)}%`;
}

console.log("MCP Shield Bench — synthetic fixtures\n");
console.log(
  `${"Case".padEnd(35)} ${"Before".padStart(10)} ${"After".padStart(10)} ${"Ratio".padStart(8)} ${"Signal OK".padStart(10)}`,
);
console.log("-".repeat(80));

// SC-002a: array cap — 100 items × 10B, field avg < 256B → only array cap fires
{
  const arr = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(8, "0") }));
  const raw = makeJsonText(arr);
  const before = byteLen(raw);
  const result = shieldMcpResult(raw);
  const after = byteLen(result);
  const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as unknown[];
  const signalOk = parsed.length === MAX_ARRAY_LENGTH + 1;
  console.log(
    `${"array cap (100×~10B items)".padEnd(35)} ${String(before).padStart(10)} ${String(after).padStart(10)} ${pct(after, before).padStart(8)} ${String(signalOk).padStart(10)}`,
  );
}

// SC-002b: heavy strip — 10 objects {id:8B, htmlContent:1KB} → htmlContent stripped
{
  const arr = Array.from({ length: 10 }, (_, i) => ({
    id: String(i).padStart(8, "0"),
    htmlContent: "x".repeat(1024),
  }));
  const raw = makeJsonText(arr);
  const before = byteLen(raw);
  const result = shieldMcpResult(raw);
  const after = byteLen(result);
  const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as unknown[];
  const item = parsed[0] as Record<string, unknown>;
  const signalOk = item.id !== undefined && item.htmlContent === undefined && Array.isArray(item._omitted);
  console.log(
    `${"heavy strip (10×{id+1KB htmlContent})".padEnd(35)} ${String(before).padStart(10)} ${String(after).padStart(10)} ${pct(after, before).padStart(8)} ${String(signalOk).padStart(10)}`,
  );
}

// SC-002c: string cap — single 20KB string → capped at MAX_STRING_LENGTH
{
  const raw = makeText("z".repeat(20 * 1024));
  const before = byteLen(raw);
  const result = shieldMcpResult(raw);
  const after = byteLen(result);
  const text = (result.content[0] as { type: "text"; text: string }).text;
  const signalOk = text.length <= MAX_STRING_LENGTH + 100 && text.includes("TRUNCATED");
  console.log(
    `${"string cap (1×20KB string)".padEnd(35)} ${String(before).padStart(10)} ${String(after).padStart(10)} ${pct(after, before).padStart(8)} ${String(signalOk).padStart(10)}`,
  );
}

// SC-002d: total cap — 64KB string + small arrays (avg<256B, <50 items)
// Only rule 4 should fire (rules 1-3 don't trigger on this fixture)
{
  const arr = Array.from({ length: 20 }, (_, i) => ({ id: String(i) })); // <50 items, avg<256B
  const bigText = "a".repeat(MAX_RESPONSE_BYTES);
  const raw: CallToolResult = {
    content: [
      { type: "text", text: bigText },
      { type: "text", text: JSON.stringify(arr) },
    ],
  };
  const before = byteLen(raw);
  const result = shieldMcpResult(raw);
  const after = byteLen(result);
  const signalOk = after <= MAX_RESPONSE_BYTES;
  console.log(
    `${"total cap (64KB + small arrays)".padEnd(35)} ${String(before).padStart(10)} ${String(after).padStart(10)} ${pct(after, before).padStart(8)} ${String(signalOk).padStart(10)}`,
  );
}

// Fail-close: image-only too large → stub
{
  const raw: CallToolResult = {
    content: [{ type: "image", data: "a".repeat(MAX_RESPONSE_BYTES + 1000), mimeType: "image/png" }],
  };
  const before = byteLen(raw);
  const result = shieldMcpResult(raw);
  const after = byteLen(result);
  const signalOk =
    result.content.length === 1 &&
    result.content[0].type === "text" &&
    (result.content[0] as { type: "text"; text: string }).text.includes("response too large");
  console.log(
    `${"fail-close image-only stub".padEnd(35)} ${String(before).padStart(10)} ${String(after).padStart(10)} ${pct(after, before).padStart(8)} ${String(signalOk).padStart(10)}`,
  );
}

console.log("\nAll cases completed.");

import { afterEach, describe, expect, test } from "vitest";
import { flattenMcpResult } from "../src/mcp/registry.js";
import {
  MAX_ARRAY_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_STRING_LENGTH,
  SIGNAL_FIELDS,
  shieldMcpResult,
} from "../src/mcp/shield.js";
import type { CallToolResult } from "../src/mcp/types.js";

function makeText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function makeJsonText(value: unknown): CallToolResult {
  return makeText(JSON.stringify(value));
}

function textOf(r: CallToolResult, idx = 0): string {
  const b = r.content[idx];
  if (b.type !== "text") throw new Error("not a text block");
  return b.text;
}

// ── Rule 1: array cap ──────────────────────────────────────────────────────

describe("rule 1 — array cap", () => {
  test("content blocks > MAX_ARRAY_LENGTH are capped", () => {
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      type: "text" as const,
      text: `block ${i}`,
    }));
    const result = shieldMcpResult({ content: blocks });
    expect(result.content).toHaveLength(MAX_ARRAY_LENGTH + 1);
    const sentinel = textOf(result, MAX_ARRAY_LENGTH);
    expect(sentinel).toContain("TRUNCATED");
    expect(sentinel).toContain("60");
  });

  test("JSON array in text > MAX_ARRAY_LENGTH is capped", () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const result = shieldMcpResult(makeJsonText(arr));
    const parsed = JSON.parse(textOf(result)) as unknown[];
    expect(parsed).toHaveLength(MAX_ARRAY_LENGTH + 1);
    const sentinel = parsed[MAX_ARRAY_LENGTH] as Record<string, unknown>;
    expect(sentinel._truncated).toBe(true);
    expect(sentinel._total).toBe(100);
  });

  test("array under limit passes through", () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
    const result = shieldMcpResult(makeJsonText(arr));
    const parsed = JSON.parse(textOf(result)) as unknown[];
    expect(parsed).toHaveLength(10);
  });
});

// ── Rule 2: heavy-field strip ──────────────────────────────────────────────

describe("rule 2 — heavy-field strip", () => {
  test("heavy non-signal fields stripped, _omitted added", () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), // signal field — preserved
      htmlContent: "y".repeat(1000), // heavy, non-signal — stripped
    }));
    const result = shieldMcpResult(makeJsonText(arr));
    const parsed = JSON.parse(textOf(result)) as unknown[];
    const item = parsed[0] as Record<string, unknown>;
    expect(item.id).toBeDefined();
    expect(item.htmlContent).toBeUndefined();
    expect(Array.isArray(item._omitted)).toBe(true);
    expect((item._omitted as string[]).includes("htmlContent")).toBe(true);
  });

  test("signal fields preserved even when heavy", () => {
    const signalKey = [...SIGNAL_FIELDS][3]; // "type" — clearly a signal field
    const arr = Array.from({ length: 10 }, (_, i) => ({
      [signalKey]: `${i}-${"x".repeat(500)}`, // heavy but signal
      junkField: "y".repeat(1000), // heavy non-signal
    }));
    const result = shieldMcpResult(makeJsonText(arr));
    const parsed = JSON.parse(textOf(result)) as unknown[];
    const item = parsed[0] as Record<string, unknown>;
    expect(item[signalKey]).toBeDefined();
    expect(item.junkField).toBeUndefined();
  });
});

// ── Rule 3: string cap ─────────────────────────────────────────────────────

describe("rule 3 — string cap", () => {
  test("string > MAX_STRING_LENGTH is truncated with marker", () => {
    const result = shieldMcpResult(makeText("a".repeat(MAX_STRING_LENGTH + 1000)));
    const text = textOf(result);
    expect(text.length).toBeLessThan(MAX_STRING_LENGTH + 200);
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("1000 more chars");
  });

  test("string at/under limit passes through unchanged", () => {
    const original = "a".repeat(MAX_STRING_LENGTH);
    const result = shieldMcpResult(makeText(original));
    expect(textOf(result)).toBe(original);
  });
});

// ── Rule 4: total size cap + fail-close ───────────────────────────────────

describe("rule 4 — total size cap", () => {
  test("response over MAX_RESPONSE_BYTES is shrunk to ≤ limit", () => {
    const result = shieldMcpResult(makeText("a".repeat(MAX_RESPONSE_BYTES)));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  test("fail-close: image-only too large → stub text block", () => {
    const result = shieldMcpResult({
      content: [
        {
          type: "image",
          data: "a".repeat(MAX_RESPONSE_BYTES + 1000),
          mimeType: "image/png",
        },
      ],
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(textOf(result)).toContain("response too large");
  });

  test("fail-close: multiple large text blocks reduced to ≤ limit", () => {
    const content = [
      { type: "text" as const, text: "a".repeat(40000) },
      { type: "text" as const, text: "b".repeat(40000) },
    ];
    const result = shieldMcpResult({ content });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

// ── 4-rule combined ───────────────────────────────────────────────────────

describe("4-rule combined", () => {
  test("all rules fire on one input and reduce size significantly", () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      htmlContent: "y".repeat(2000), // heavy non-signal
      longText: "z".repeat(9000), // long string
    }));
    const raw = makeJsonText(arr);
    const rawSize = JSON.stringify(raw).length;
    const result = shieldMcpResult(raw);
    const resultSize = JSON.stringify(result).length;
    expect(resultSize).toBeLessThan(rawSize * 0.5); // at least 50% reduction
    expect(resultSize).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

// ── Kill switches (via flattenMcpResult integration) ──────────────────────

describe("kill switches", () => {
  afterEach(() => {
    process.env.REASONIX_SHIELD = undefined;
    process.env.REASONIX_TOON = undefined;
  });

  test("REASONIX_SHIELD=0 bypasses shield entirely", () => {
    process.env.REASONIX_SHIELD = "0";
    process.env.REASONIX_TOON = "off"; // prevent toon encoding from wrapping JSON
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const raw: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify(arr) }],
    };
    const out = flattenMcpResult(raw);
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(100); // shield bypassed → full array
  });

  test("mcpShield.enabled=false bypasses shield via opts", () => {
    process.env.REASONIX_TOON = "off";
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const raw: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify(arr) }],
    };
    const out = flattenMcpResult(raw, { mcpShield: { enabled: false } });
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(100);
  });

  test("shield active by default (no env, no opts)", () => {
    process.env.REASONIX_TOON = "off";
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const raw: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify(arr) }],
    };
    const out = flattenMcpResult(raw);
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(MAX_ARRAY_LENGTH + 1); // capped + sentinel
  });
});

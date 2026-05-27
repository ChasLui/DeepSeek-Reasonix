// SPDX-License-Identifier: MIT — borrowed from harshal-mcp-proxy; see THIRD_PARTY_NOTICES.md

import type { CallToolResult, McpContentBlock } from "./types.js";

// ── Constants (borrowed from harshal-mcp-proxy response-store.ts:34-54) ──
export const MAX_ARRAY_LENGTH = 50;
export const MAX_STRING_LENGTH = 8192;
export const MAX_RESPONSE_BYTES = 65536; // 64KB
export const HEAVY_FIELD_THRESHOLD = 256;

/** Signal fields that survive heavy-field strip regardless of size. */
export const SIGNAL_FIELDS = new Set([
  "id",
  "name",
  "title",
  "type",
  "status",
  "state",
  "label",
  "sha",
  "ref",
  "path",
  "url",
  "html_url",
  "created_at",
  "updated_at",
  "number",
  "key",
  "message",
  "description",
  "summary",
  "error",
]);

// biome-ignore lint/suspicious/noEmptyInterface: reserved for future cap overrides
export interface ShieldOptions {}

// Pure fn: (1) array cap ≤50, (2) heavy-field strip, (3) string cap ≤8KB, (4) total cap ≤64KB. Stateless. Borrowed from harshal-mcp-proxy (MIT).
export function shieldMcpResult(raw: CallToolResult, _opts?: ShieldOptions): CallToolResult {
  // Rules 1-3: applied to text block content (recursively via processValue)
  let content: McpContentBlock[] = raw.content.map((block) => {
    if (block.type !== "text") return block;
    const processed = processValue(block.text);
    const text = typeof processed === "string" ? processed : JSON.stringify(processed);
    return { type: "text" as const, text };
  });

  // Rule 1: content array cap (if > MAX_ARRAY_LENGTH blocks)
  if (content.length > MAX_ARRAY_LENGTH) {
    const total = content.length;
    content = [
      ...content.slice(0, MAX_ARRAY_LENGTH),
      {
        type: "text" as const,
        text: `[TRUNCATED: showing ${MAX_ARRAY_LENGTH} of ${total} content blocks]`,
      },
    ];
  }

  // Rule 4: total size cap
  const shielded: CallToolResult = { ...raw, content };
  if (JSON.stringify(shielded).length > MAX_RESPONSE_BYTES) {
    return enforceMaxSize(shielded);
  }

  return shielded;
}

// Applies rules 1-3 recursively to arbitrary values (text block content or nested JSON).
function processValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Rule 1: array cap
    const capped = value.length > MAX_ARRAY_LENGTH ? capArray(value) : value;
    // Rule 2: heavy-field strip on array-of-objects (applied to capped array)
    const stripped = stripHeavyFields(capped as unknown[]);
    // Recurse into items (applies rules 1-3 to element strings/nested arrays)
    return (stripped as unknown[]).map((item) => processValue(item));
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = processValue(v);
    }
    return result;
  }

  if (typeof value === "string") {
    // Detect embedded JSON (arrays or objects) in long strings and apply all rules recursively
    if (value.length > 1000) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) || (parsed !== null && typeof parsed === "object")) {
          return JSON.stringify(processValue(parsed));
        }
      } catch {
        // Not parseable JSON — fall through to string cap
      }
    }
    // Rule 3: string cap
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}\n[...TRUNCATED: ${value.length - MAX_STRING_LENGTH} more chars]`;
    }
    return value;
  }

  return value; // number, boolean, null — pass through
}

function capArray(arr: unknown[]): unknown[] {
  return [
    ...arr.slice(0, MAX_ARRAY_LENGTH),
    {
      _truncated: true,
      _total: arr.length,
      _showing: MAX_ARRAY_LENGTH,
      _message: `[TRUNCATED: ${arr.length - MAX_ARRAY_LENGTH} more items]`,
    },
  ];
}

function stripHeavyFields(arr: unknown[]): unknown[] {
  if (arr.length <= 5) return arr;

  const sampleSize = Math.min(arr.length, 10);
  const sample = arr.slice(0, sampleSize);
  if (!sample.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    return arr;
  }

  const fieldSizes = new Map<string, number>();
  const fieldCounts = new Map<string, number>();
  for (const item of sample) {
    for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
      const size = JSON.stringify(val).length;
      fieldSizes.set(key, (fieldSizes.get(key) ?? 0) + size);
      fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    }
  }

  const heavyFields: string[] = [];
  for (const [field, totalSize] of fieldSizes) {
    const count = fieldCounts.get(field) ?? 1;
    if (totalSize / count > HEAVY_FIELD_THRESHOLD && !SIGNAL_FIELDS.has(field)) {
      heavyFields.push(field);
    }
  }

  if (heavyFields.length === 0) return arr;

  return arr.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const obj = item as Record<string, unknown>;
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!heavyFields.includes(k)) stripped[k] = v;
    }
    stripped._omitted = heavyFields;
    return stripped;
  });
}

// Rule 4 enforcer: iterative shrink of largest text block + fail-close stub.
function enforceMaxSize(result: CallToolResult): CallToolResult {
  let current: CallToolResult = { ...result, content: [...result.content] };

  for (let i = 0; i < 20; i++) {
    if (JSON.stringify(current).length <= MAX_RESPONSE_BYTES) break;

    // Find the largest text block and halve it
    let maxLen = 0;
    let maxIdx = -1;
    for (let j = 0; j < current.content.length; j++) {
      const block = current.content[j];
      if (block?.type === "text" && block.text.length > maxLen) {
        maxLen = block.text.length;
        maxIdx = j;
      }
    }

    if (maxIdx === -1 || maxLen <= 100) break; // no shrinkable text blocks

    const newContent = [...current.content];
    const block = newContent[maxIdx];
    if (block?.type === "text") {
      newContent[maxIdx] = {
        type: "text" as const,
        text: `${block.text.slice(0, Math.floor(maxLen / 2))}\n[...TRUNCATED to fit 64KB limit]`,
      };
    }
    current = { ...current, content: newContent };
  }

  // Fail-close: still too large after 20 iterations
  if (JSON.stringify(current).length > MAX_RESPONSE_BYTES) {
    const firstText = current.content.find(
      (b): b is { type: "text"; text: string } => b.type === "text",
    );
    if (firstText) {
      return {
        ...current,
        content: [{ type: "text" as const, text: firstText.text.slice(0, 32768) }],
      };
    }
    // No text blocks (e.g., image-only): discard all content, emit stub
    return {
      ...current,
      content: [
        {
          type: "text" as const,
          text: "[response too large, all content discarded]",
        },
      ],
    };
  }

  return current;
}

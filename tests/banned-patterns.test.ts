/** Prototype-pollution guard — static lookup tables must use nullPrototype()/emptyMap(). */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Baseline allowlist — initially captured 14 pre-existing violations, now empty after Task 5
 *  migration (2026-05-20 plan: just-bash-sandbox-borrow). New violations are not allowed —
 *  use `nullPrototype()` from `src/utils/safe-object.ts` or add `// @banned-pattern-ignore: <reason>`. */
const ALLOWLIST: ReadonlySet<string> = new Set<string>();

/** Top-level `const NAME: <type incl. Record> = { ... }` lookup tables — must be wrapped. */
const LOOKUP_TABLE_RE =
  /^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*:\s*(?:Readonly<)?Record<[^=]*=\s*(\{)/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === "dist") continue;
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (name.name.endsWith(".ts") && !name.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("banned-patterns: prototype pollution guard", () => {
  const files = walk(SRC_ROOT);

  it("scans the src tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    it(`${rel} — static Record lookup tables use nullPrototype()`, () => {
      const src = readFileSync(file, "utf8");
      // Split into lines and walk; for every const X: Record<...> = ..., the same statement
      // (across continuation lines) must contain nullPrototype( or emptyMap( or Object.create(null
      // or a // @banned-pattern-ignore comment.
      const lines = src.split("\n");
      const violations: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*:\s*(?:Readonly<)?Record</.test(line))
          continue;
        // Capture up to ~10 following lines as the statement window.
        const window = lines.slice(i, i + 10).join("\n");
        if (/nullPrototype\(|emptyMap\(|Object\.create\(null|@banned-pattern-ignore/.test(window))
          continue;
        // The right-hand side must contain an object literal `{` for this rule to apply.
        // IIFE forms like `(() => {...})()` are out of scope.
        if (!/=\s*\{/.test(window)) continue;
        const key = `${rel}:${i + 1}`;
        if (ALLOWLIST.has(key)) continue;
        violations.push(`${key}: ${line.trim().slice(0, 100)}`);
      }
      expect(
        violations,
        `lookup tables missing nullPrototype():\n${violations.join("\n")}`,
      ).toEqual([]);
    });
  }
});

/** Regex-based body stripper for signature surveys: ts/tsx/js/jsx/mjs/cjs/py/go/rs; never AST. */

import * as pathMod from "node:path";

/** Trailing footer we append so the model knows it can ask for full content. */
export const AGGRESSIVE_FOOTER =
  '\n\n[… aggressive mode: bodies stripped — re-read with level="minimal" for full content …]';

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);

export function isAggressiveSupported(filePath: string): boolean {
  return SUPPORTED_EXTS.has(pathMod.extname(filePath).toLowerCase());
}

/** Strip block comments + line comments, then collapse `{ … }` blocks at function/class scope. */
export function applyAggressive(content: string, filePath: string): string {
  const ext = pathMod.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return content;
  // Python uses indentation; everything else uses braces.
  if (ext === ".py") return aggressivePython(content);
  return aggressiveBraced(content);
}

/** Brace-based languages: walk the source, keep first line of every function-like header,
 *  collapse the matching block, drop nested blocks. Crude but no AST. */
function aggressiveBraced(content: string): string {
  // Strip comments first — string-aware so URLs in strings survive.
  const stripped = stripBracedComments(content);
  // Header markers we want to preserve verbatim.
  const headerRe =
    /^(\s*)(?:export\s+(?:default\s+)?(?:async\s+)?(?:function\b|class\b|interface\b|type\b|enum\b)|(?:async\s+)?function\b|class\b|interface\b|type\b|enum\b|(?:public|private|protected|static|readonly|abstract|async)\s+(?!=)|(?:const|let|var)\s+\w+\s*[:=]\s*(?:async\s*)?\(.*?\)\s*=>|fn\s+\w+|pub\s+fn\s+\w+|impl\b|trait\b|struct\b|func\s+\w+)/;
  const out: string[] = [];
  const lines = stripped.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (headerRe.test(l)) {
      // Walk until the first `{` (header may wrap across lines).
      const startLine = i;
      let headerBuf = l;
      let openIdx = headerBuf.indexOf("{");
      while (openIdx < 0 && i + 1 < lines.length) {
        i += 1;
        headerBuf += `\n${lines[i]}`;
        openIdx = headerBuf.indexOf("{");
      }
      if (openIdx < 0) {
        // Header without a body (interface/type alias/declaration-only): keep as-is.
        for (let k = startLine; k <= i; k++) out.push(lines[k]!);
        i += 1;
        continue;
      }
      // Push header lines up to and including the `{` line, with `{ … }` collapsed.
      const headerLines = headerBuf.split(/\r?\n/);
      const lastIdx = headerLines.length - 1;
      headerLines[lastIdx] = headerLines[lastIdx]!.replace(/\{[^}]*$/, "{ … }");
      out.push(...headerLines.slice(0, lastIdx + 1));
      // Now skip until the matching brace at the original depth.
      let depth = 1;
      i += 1;
      while (i < lines.length && depth > 0) {
        depth += countChar(lines[i]!, "{");
        depth -= countChar(lines[i]!, "}");
        i += 1;
      }
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out.join("\n");
}

/** Python: collapse `def`/`async def`/`class` body to `: ...` by walking indent. */
function aggressivePython(content: string): string {
  const stripped = stripPythonComments(content);
  const lines = stripped.split(/\r?\n/);
  const out: string[] = [];
  const headerRe = /^(\s*)(?:async\s+def|def|class)\s+\w+/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const m = l.match(headerRe);
    if (!m) {
      out.push(l);
      i += 1;
      continue;
    }
    const indent = (m[1] ?? "").length;
    // Capture multi-line header until trailing `:`.
    let header = l;
    while (!/:\s*(?:#.*)?$/.test(header) && i + 1 < lines.length) {
      i += 1;
      header += `\n${lines[i]}`;
    }
    out.push(`${header.replace(/:\s*$/, ": ...")}`);
    // Skip the body: every subsequent non-blank line with indent > header indent.
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j]!;
      if (next.trim() === "") {
        j += 1;
        continue;
      }
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nextIndent <= indent) break;
      j += 1;
    }
    i = j;
  }
  return out.join("\n");
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n += 1;
  return n;
}

// String-aware comment stripper for block comments and line comments.
function stripBracedComments(s: string): string {
  let out = "";
  let i = 0;
  let str: '"' | "'" | "`" | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (str) {
      if (c === "\\" && i + 1 < s.length) {
        out += c + s[i + 1];
        i += 2;
        continue;
      }
      if (c === str) str = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      // block comment
      const end = s.indexOf("*/", i + 2);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      // preserve newlines inside the comment so line numbers don't shift
      const inner = s.slice(i, end + 2);
      for (const ch of inner) if (ch === "\n") out += "\n";
      i = end + 2;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      // line comment → eat to newline (don't include the newline)
      const nl = s.indexOf("\n", i + 2);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function stripPythonComments(s: string): string {
  const out: string[] = [];
  let inTripleStr = false;
  let tripleDelim: '"""' | "'''" | null = null;
  for (const line of s.split(/\r?\n/)) {
    if (inTripleStr && tripleDelim) {
      out.push(line);
      if (line.includes(tripleDelim)) {
        inTripleStr = false;
        tripleDelim = null;
      }
      continue;
    }
    const opens = line.indexOf('"""') >= 0 ? '"""' : line.indexOf("'''") >= 0 ? "'''" : null;
    if (opens) {
      out.push(line);
      // a triple that opens and closes on the same line stays inline
      if (line.lastIndexOf(opens) === line.indexOf(opens)) {
        inTripleStr = true;
        tripleDelim = opens;
      }
      continue;
    }
    // strip "# …" line comment (not inside a string we tracked above)
    const hash = findUnquoted(line, "#");
    out.push(hash < 0 ? line : line.slice(0, hash).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

function findUnquoted(line: string, needle: string): number {
  let str: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (str) {
      if (c === "\\" && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      continue;
    }
    if (c === needle) return i;
  }
  return -1;
}

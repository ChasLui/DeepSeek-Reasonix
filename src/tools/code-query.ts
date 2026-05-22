import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import {
  type CodeMatchKind,
  type FindInCodeOptions,
  findInCode,
} from "../code-query/find-in-code.js";
import { grammarForPath } from "../code-query/parser.js";
import {
  type DetectChangesScope,
  detectChanges,
  findReferences,
  impact,
} from "../code-query/relations.js";
import { recordCodeRelationQuery } from "../code-query/stats.js";
import { extractSymbols } from "../code-query/symbols.js";
import type { ToolRegistry } from "../tools.js";

export interface CodeQueryToolOpts {
  rootDir: string;
  codeRelationsEnabled?: boolean;
}

const UNSUPPORTED =
  "language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use search_content for grep-style matching";
const CODE_RELATION_TOOL_NAMES = ["find_references", "detect_changes", "impact"] as const;

export function registerCodeQueryTools(registry: ToolRegistry, opts: CodeQueryToolOpts): void {
  const { rootDir } = opts;

  registry.register({
    name: "get_symbols",
    description:
      "Outline a single TS/TSX/JS/JSX/Python/Go/Rust/Java file via tree-sitter — returns its top-level + nested symbols (functions, classes, methods, interfaces, types, enums, namespaces) with 1-based line/column. Grammar-aware, ignores names inside comments/strings. Use for 'what's in this file' / 'where is X defined here'; for cross-file scans use search_content. Result: {path, symbols:[{name, kind, line, column, endLine, endColumn, parent?}]} or {path, error}.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to project root or absolute).",
        },
      },
      required: ["path"],
    },
    fn: async (args: { path: string }) => {
      const filePath = resolveProjectPath(rootDir, args.path);
      if (!grammarForPath(filePath)) {
        return JSON.stringify({ path: args.path, error: UNSUPPORTED });
      }
      const source = await readFile(filePath, "utf8");
      const symbols = await extractSymbols(filePath, source);
      return JSON.stringify({ path: args.path, symbols });
    },
  });

  registry.register({
    name: "find_in_code",
    description:
      "Find an identifier `name` in a single TS/TSX/JS/JSX/Python/Go/Rust/Java file, AST-filtered — skips matches inside comments and strings. Optional `kind` narrows by syntactic role: 'call' (function call site), 'definition' (declaration name), 'reference' (other uses), 'any' (default). Within-file only — does NOT resolve cross-file references; use search_content + reading for that. Result: {path, matches:[{line, column, kind, snippet}]} or {path, error}.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact identifier text to find.",
        },
        path: {
          type: "string",
          description: "File path (relative to project root or absolute).",
        },
        kind: {
          type: "string",
          enum: ["any", "call", "definition", "reference"],
          description: "Filter by syntactic role. Default 'any'.",
        },
      },
      required: ["name", "path"],
    },
    fn: async (args: { name: string; path: string; kind?: string }) => {
      const filePath = resolveProjectPath(rootDir, args.path);
      if (!grammarForPath(filePath)) {
        return JSON.stringify({ path: args.path, error: UNSUPPORTED });
      }
      const source = await readFile(filePath, "utf8");
      const kind = (args.kind ?? "any") as CodeMatchKind | "any";
      const findOpts: FindInCodeOptions = kind === "any" ? {} : { kind };
      const matches = await findInCode(filePath, source, args.name, findOpts);
      return JSON.stringify({ path: args.path, matches });
    },
  });

  if (opts.codeRelationsEnabled === false) {
    for (const name of CODE_RELATION_TOOL_NAMES) registry.unregister(name);
    return;
  }

  registry.register({
    name: "find_references",
    description:
      "On-demand code relation query for TS/TSX/JS/JSX/Python/Go/Rust/Java without a persistent graph. Use for 'who calls X', 'what does X call', or import relationships before editing. Best-effort, deterministic, confidence-tagged; heavy transitive graph work should use external GitNexus MCP. Result: {symbol,relation,records:[{file,line,column,from?,to?,confidence,reason,snippet?}],bestEffort}.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "Function/class/method/import name, qualified parent.name, or file path for imports/importers.",
        },
        relation: {
          type: "string",
          enum: ["callers", "callees", "importers", "imports"],
          description:
            "callers = call sites of symbol; callees = calls inside symbol; importers/imports inspect module edges.",
        },
        scope: {
          type: "string",
          description:
            "Optional file or directory relative to project root. Default scans the project with generated/vendor dirs skipped.",
        },
      },
      required: ["symbol", "relation"],
    },
    fn: async (args: { symbol: string; relation: string; scope?: string }) => {
      try {
        const relation = args.relation as "callers" | "callees" | "importers" | "imports";
        return JSON.stringify(await findReferences(rootDir, { ...args, relation }));
      } catch (err) {
        recordCodeRelationQuery({ fallback: true });
        return JSON.stringify({
          error: `find_references failed: ${(err as Error).message}`,
          fallback: "Use search_content for raw grep hits, then read_file on the candidate files.",
        });
      }
    },
  });

  registry.register({
    name: "detect_changes",
    description:
      "Map current git diff hunks to affected code symbols by tree-sitter span overlap. Use after edits to self-check what symbols changed before choosing tests. scope: unstaged (default), staged, or all. includeCallers=true expands each changed symbol to direct callers via find_references. No persistent index.",
    readOnly: true,
    parallelSafe: false,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["unstaged", "staged", "all"],
          description: "Which git diff to inspect. Default 'unstaged'.",
        },
        includeCallers: {
          type: "boolean",
          description: "When true, attach direct callers for each changed symbol.",
        },
      },
    },
    fn: async (args: { scope?: string; includeCallers?: boolean }) => {
      try {
        return JSON.stringify(
          await detectChanges(rootDir, {
            scope: (args.scope ?? "unstaged") as DetectChangesScope,
            includeCallers: args.includeCallers === true,
          }),
        );
      } catch (err) {
        recordCodeRelationQuery({ fallback: true });
        return JSON.stringify({
          error: `detect_changes failed: ${(err as Error).message}`,
          fallback: "Run git diff -U0, then get_symbols on touched files.",
        });
      }
    },
  });

  registry.register({
    name: "impact",
    description:
      "Best-effort shallow reverse impact analysis. Starts from symbol, follows direct callers up to maxDepth<=2, and groups records by depth with confidence tags. Use for quick edit blast-radius checks; complete transitive closures/Cypher belong to external GitNexus MCP.",
    readOnly: true,
    parallelSafe: false,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Function/class/method name to analyze.",
        },
        direction: {
          type: "string",
          enum: ["callers"],
          description: "Only callers is supported; other directions need a persistent graph.",
        },
        maxDepth: {
          type: "number",
          description: "Requested caller depth. Hard-capped to 2.",
        },
        minConfidence: {
          type: "string",
          enum: ["AMBIGUOUS", "INFERRED", "EXTRACTED"],
          description: "Minimum relation confidence to include. Default AMBIGUOUS.",
        },
        scope: {
          type: "string",
          description: "Optional file or directory relative to project root.",
        },
      },
      required: ["symbol"],
    },
    fn: async (args: {
      symbol: string;
      direction?: string;
      maxDepth?: number;
      minConfidence?: "AMBIGUOUS" | "INFERRED" | "EXTRACTED";
      scope?: string;
    }) => {
      try {
        return JSON.stringify(
          await impact(rootDir, {
            symbol: args.symbol,
            direction: "callers",
            maxDepth: args.maxDepth,
            minConfidence: args.minConfidence,
            scope: args.scope,
          }),
        );
      } catch (err) {
        recordCodeRelationQuery({ fallback: true });
        return JSON.stringify({
          error: `impact failed: ${(err as Error).message}`,
          fallback: "Use find_references relation=callers for one shallow step.",
        });
      }
    },
  });
}

function resolveProjectPath(rootDir: string, raw: string): string {
  const stripped = raw.replace(/^[/\\]+/, "");
  return pathResolve(rootDir, stripped.length === 0 ? "." : stripped);
}

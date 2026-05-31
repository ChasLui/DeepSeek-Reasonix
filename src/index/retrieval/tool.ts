import type { ToolRegistry } from "../../tools.js";
import { type RetrieveResult, retrieveCode } from "./engine.js";

const FIND_CODE_DESCRIPTION =
  "Intent-driven hybrid code search: fuses lexical BM25, semantic embeddings, and the call graph into one ranked list. Use this FIRST for fuzzy code-finding — 'where is X handled', 'how does Y work', 'what code is responsible for Z' — especially when you don't know the exact identifier. Works without an embedder (BM25 is always-on); semantic and graph add precision when available. For an exact string/regex use search_content; for precise callers/callees of a KNOWN symbol use find_references.";

// Not readOnly / not parallelSafe: the first call may lazily build the lexical
// index (writes .reasonix/index/lexical/), so a serial barrier avoids racing
// concurrent builds — same posture as find_references' graph build.
export function registerFindCodeTool(registry: ToolRegistry, root: string): void {
  registry.register({
    name: "find_code",
    description: FIND_CODE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language intent ('where do we validate the session cookie') or an identifier ('PrefixCache'). Identifier-like queries also pull call-graph neighbors.",
        },
        topK: {
          type: "integer",
          description: "Number of results to return (1..16). Default 8.",
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string; topK?: number }) => {
      const result = await retrieveCode(root, args.query, {
        topK: clampTopK(args.topK),
      });
      return formatRetrieval(args.query, result);
    },
  });
}

function clampTopK(n: number | undefined): number {
  const v = Number.isFinite(n) ? (n as number) : 8;
  return Math.max(1, Math.min(16, v));
}

export function formatRetrieval(query: string, result: RetrieveResult): string {
  const { hits, sourcesUsed, notes } = result;
  if (hits.length === 0) {
    const note = notes.length > 0 ? `\n${notes.join("\n")}` : "";
    return `query: ${query}\n\nno code matches.${note}`;
  }
  const src = sourcesUsed.length > 0 ? sourcesUsed.join(", ") : "none";
  const lines: string[] = [`query: ${query}`, `sources: ${src}`, `\nresults (${hits.length}):`];
  hits.forEach((h, i) => {
    const tag = h.sources.join("+");
    lines.push(
      `\n${i + 1}. ${h.path}:${h.startLine}-${h.endLine}  [${tag}]  (score ${h.score.toFixed(3)})`,
    );
    if (h.snippet) {
      const preview = h.snippet
        .split("\n")
        .slice(0, 6)
        .map((l) => `   ${l}`)
        .join("\n");
      lines.push(preview);
    }
  });
  if (notes.length > 0) lines.push(`\n${notes.join("\n")}`);
  return lines.join("\n");
}

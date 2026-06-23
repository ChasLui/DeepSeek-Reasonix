// Pillar 5 opt-in pre-turn retrieval factory (Slice 5). Builds the callback the
// loop injects AFTER the user message; best-effort + precision-gated + no-op on
// cold/no-match so a turn is never broken and never polluted.

import type { PreTurnInjection } from "../../loop.js";
import { countTokens } from "../../tokenizer.js";
import { retrieveCode } from "./engine.js";
import type { RetrievalHit } from "./types.js";

export interface ActiveRetrievalOptions {
  topK?: number | undefined;
  /** Skip injection when the top fused score is below this (0 = gate on hits only). */
  minScore?: number | undefined;
}

export function buildPreTurnRetrieval(
  root: string,
  opts: ActiveRetrievalOptions = {},
): (userInput: string) => Promise<PreTurnInjection | null> {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  return async (userInput: string): Promise<PreTurnInjection | null> => {
    let hits: RetrievalHit[];
    try {
      ({ hits } = await retrieveCode(root, userInput, { topK }));
    } catch {
      return null;
    }
    if (hits.length === 0) return null;
    if (minScore > 0 && (hits[0]?.score ?? 0) < minScore) return null;
    const content = formatInjectionBlock(userInput, hits);
    const note = `🔎 pre-turn retrieval: ${hits.length} snippet(s) injected (+~${countTokens(content)} cache-miss tokens this turn)`;
    return { content, note };
  };
}

function formatInjectionBlock(query: string, hits: readonly RetrievalHit[]): string {
  const lines: string[] = [`[pre-turn retrieved context for: ${query}]`];
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.path}:${h.startLine}-${h.endLine}`);
    if (h.snippet) {
      lines.push(
        h.snippet
          .split("\n")
          .slice(0, 5)
          .map((l) => `   ${l}`)
          .join("\n"),
      );
    }
  });
  lines.push("(injected by pre-turn retrieval — read_file for the full content)");
  return lines.join("\n");
}

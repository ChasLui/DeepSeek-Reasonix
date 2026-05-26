import type { MultilineAction } from "./multiline-keys.js";

export interface HistoryScrollRoutingInput {
  source: MultilineAction["historyHandoffSource"];
  direction: "prev" | "next";
  input: string;
  scrollRows: number;
  maxScroll: number;
}

export function shouldRouteHistoryHandoffToChatScroll({
  source,
  direction,
  input,
  scrollRows,
  maxScroll,
}: HistoryScrollRoutingInput): boolean {
  if (source !== "arrow" || input.length > 0) return false;
  return direction === "prev" ? scrollRows > 0 : scrollRows < maxScroll;
}

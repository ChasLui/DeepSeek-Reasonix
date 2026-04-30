import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { clipToCells } from "../../../frame/width.js";
import { BarRow, CursorBlock } from "../primitives/BarRow.js";
import type { ReasoningCard as ReasoningCardData } from "../state/cards.js";
import { FG } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

/** Fixed tail for streaming — prevents the live region from growing past the terminal and forcing the OS to scroll on every byte. Full content lands in scrollback when streaming completes. */
const STREAMING_TAIL = 6;
const DONE_PREVIEW_TAIL = 3;
const BODY_INDENT_CELLS = 5;

export function ReasoningCard({
  card,
  expanded,
}: {
  card: ReasoningCardData;
  expanded: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const lineCells = Math.max(20, cols - BODY_INDENT_CELLS - 1);
  const meta = card.aborted
    ? "aborted"
    : card.streaming
      ? "streaming…"
      : `${card.paragraphs} paragraph${card.paragraphs === 1 ? "" : "s"} · ${card.tokens} tok`;

  const allLines = card.text.length > 0 ? card.text.split("\n") : [];
  const tailSize = card.streaming ? STREAMING_TAIL : DONE_PREVIEW_TAIL;
  const overflows = allLines.length > tailSize;
  const lineSlots = overflows ? tailSize - 1 : allLines.length;
  const visible = overflows ? allLines.slice(-lineSlots) : allLines;
  const headDropped = overflows ? allLines.length - visible.length : 0;
  const showBody = expanded && allLines.length > 0;

  return (
    <Box flexDirection="column">
      <CardHeader tone="reasoning" glyph="◆" title="Reasoning" meta={`· ${meta}`} />
      {showBody && (
        <>
          <BarRow tone="reasoning" indent={0} />
          {headDropped > 0 && (
            <BarRow tone="reasoning">
              <Text color={FG.faint}>
                {card.streaming
                  ? `… ${headDropped} earlier line${headDropped === 1 ? "" : "s"} (will appear in scrollback)`
                  : `⋮ ${headDropped} earlier line${headDropped === 1 ? "" : "s"}`}
              </Text>
            </BarRow>
          )}
          {visible.map((line, i) => {
            const isLast = i === visible.length - 1;
            return (
              <BarRow key={`${card.id}:${headDropped + i}`} tone="reasoning">
                <Text italic color={FG.meta}>
                  {clipToCells(line, lineCells)}
                </Text>
                {isLast && card.streaming && <CursorBlock />}
              </BarRow>
            );
          })}
        </>
      )}
    </Box>
  );
}

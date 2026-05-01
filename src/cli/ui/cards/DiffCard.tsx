import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { DiffCard as DiffCardData } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const LINE_COLOR = {
  ctx: FG.sub,
  add: TONE.ok,
  del: TONE.err,
  fold: FG.faint,
} as const;

export function DiffCard({ card }: { card: DiffCardData }): React.ReactElement {
  const meta = (
    <>
      <Text color={TONE.ok}>{`+${card.stats.add}`}</Text>
      <Text color={FG.faint}>{" / "}</Text>
      <Text color={TONE.err}>{`-${card.stats.del}`}</Text>
    </>
  );
  const showFooter = card.hunks.length > 0;
  return (
    <Box flexDirection="column">
      <CardHeader tone="diff" glyph="±" title="Edit" subtitle={card.file} trailing={meta} />
      {card.hunks.map((hunk) => (
        <Box key={`${card.id}:${hunk.header}`} flexDirection="column">
          <BarRow tone="diff" indent={0} />
          <BarRow tone="diff">
            <Text italic color={FG.faint}>
              {hunk.header}
            </Text>
          </BarRow>
          {hunk.lines.map((line, li) => (
            <BarRow key={`${card.id}:${hunk.header}:${li}`} tone="diff">
              <Text color={LINE_COLOR[line.kind]}>{line.text}</Text>
            </BarRow>
          ))}
        </Box>
      ))}
      {showFooter && (
        <>
          <BarRow tone="diff" indent={0} />
          <BarRow tone="diff">
            <Text bold color={TONE.ok}>
              {"[a] apply"}
            </Text>
            <Text color={FG.sub}>{"   [s] skip   "}</Text>
            <Text bold color={TONE.err}>
              {"[r] reject"}
            </Text>
          </BarRow>
        </>
      )}
    </Box>
  );
}

import { Text } from "ink";
import { Box } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { BranchCard as BranchCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const BAR_CELLS = 28;

export function BranchCard({ card }: { card: BranchCardData }): React.ReactElement {
  const ratio = card.total > 0 ? card.completed / card.total : 0;
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  const tone = card.done ? TONE.ok : CARD.streaming.color;
  return (
    <Box flexDirection="column">
      <CardHeader
        tone="streaming"
        glyph="⎇"
        title={card.done ? "Branching done" : "Branching"}
        meta={`· ${card.completed} of ${card.total} samples`}
        barColor={tone}
      />
      <BarRow tone="streaming" indent={0} />
      <BarRow tone="streaming">
        <Text color={tone}>{"█".repeat(filled)}</Text>
        <Text color={FG.faint}>{"░".repeat(BAR_CELLS - filled)}</Text>
        <Text color={FG.faint}>{`  ${(ratio * 100).toFixed(0)}%`}</Text>
      </BarRow>
      {!card.done && card.completed > 0 && (
        <BarRow tone="streaming">
          <Text color={FG.faint}>
            {`latest: #${card.latestIndex} · T=${card.latestTemperature.toFixed(2)} · ${card.latestUncertainties} unc`}
          </Text>
        </BarRow>
      )}
    </Box>
  );
}

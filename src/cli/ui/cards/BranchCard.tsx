import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { CardHeader } from "../primitives/CardHeader.js";
import type { BranchCard as BranchCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";

const BAR_CELLS = 28;

export function BranchCard({ card }: { card: BranchCardData }): React.ReactElement {
  const ratio = card.total > 0 ? card.completed / card.total : 0;
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  const tone = card.done ? TONE.ok : CARD.branch.color;
  return (
    <Box flexDirection="column" marginTop={1}>
      <CardHeader
        glyph="⎇"
        tone={tone}
        title={card.done ? "branching done" : "branching"}
        meta={[`${card.completed} of ${card.total} samples`]}
      />
      <Box paddingLeft={2} flexDirection="row" gap={1}>
        <Text color={tone}>{"█".repeat(filled)}</Text>
        <Text color={FG.faint}>{"░".repeat(BAR_CELLS - filled)}</Text>
        <Text color={FG.faint}>{`${(ratio * 100).toFixed(0)}%`}</Text>
      </Box>
      {!card.done && card.completed > 0 ? (
        <Box paddingLeft={2}>
          <Text color={FG.faint}>
            {`latest · #${card.latestIndex} · T=${card.latestTemperature.toFixed(2)} · ${card.latestUncertainties} unc`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

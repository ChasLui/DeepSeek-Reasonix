import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { WarnCard as WarnCardData } from "../state/cards.js";
import { FG } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

export function WarnCard({ card }: { card: WarnCardData }): React.ReactElement {
  const showBody = card.message.length > 0;
  return (
    <Box flexDirection="column">
      <CardHeader
        tone="warn"
        glyph="⚠"
        title={card.title}
        meta={card.detail ? `· ${card.detail}` : undefined}
      />
      {showBody && (
        <>
          <BarRow tone="warn" indent={0} />
          {card.message.split("\n").map((line, i) => (
            <BarRow key={`${card.id}:${i}`} tone="warn">
              <Text color={FG.body}>{line}</Text>
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}

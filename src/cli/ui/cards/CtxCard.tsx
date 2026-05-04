import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Card } from "../primitives/Card.js";
import { CardHeader } from "../primitives/CardHeader.js";
import type { CtxCard as CtxCardData } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";

const BAR_CELLS = 32;

function row(label: string, tokens: number, ratio: number, color: string): React.ReactElement {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={FG.sub}>{label.padEnd(7)}</Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={FG.faint}>{"░".repeat(BAR_CELLS - filled)}</Text>
      <Text bold color={FG.body}>
        {tokens.toLocaleString()}
      </Text>
      <Text color={FG.faint}>{`· ${(ratio * 100).toFixed(1)}%`}</Text>
    </Box>
  );
}

export function CtxCard({ card }: { card: CtxCardData }): React.ReactElement {
  const cap = Math.max(1, card.ctxMax);
  const used = card.systemTokens + card.toolsTokens + card.logTokens + card.inputTokens;
  const usedPct = (used / cap) * 100;

  return (
    <Card tone={TONE.brand}>
      <CardHeader
        glyph="⌘"
        tone={TONE.brand}
        title="context"
        meta={[`${used.toLocaleString()} / ${cap.toLocaleString()} (${usedPct.toFixed(1)}%)`]}
      />
      {row("system", card.systemTokens, card.systemTokens / cap, TONE.brand)}
      {row("tools", card.toolsTokens, card.toolsTokens / cap, TONE.warn)}
      {row("log", card.logTokens, card.logTokens / cap, TONE.ok)}
      {row("input", card.inputTokens, card.inputTokens / cap, TONE.accent)}
      {card.topTools.length > 0 ? (
        <>
          <Text color={FG.faint}>
            {`top tools · ${card.toolsCount} total · ${card.logMessages} log msgs`}
          </Text>
          {card.topTools.slice(0, 5).map((t) => (
            <Box key={`${t.turn}-${t.name}`} flexDirection="row" gap={1}>
              <Text color={FG.sub}>{t.name}</Text>
              <Text color={FG.faint}>{`· turn ${t.turn} · ${t.tokens.toLocaleString()}`}</Text>
            </Box>
          ))}
        </>
      ) : null}
    </Card>
  );
}

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { UsageCard as UsageCardData } from "../state/cards.js";
import { FG, TONE, formatCNY } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const BAR_CELLS = 30;

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function bar(ratio: number, color: string): React.ReactElement {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  const empty = BAR_CELLS - filled;
  return (
    <>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={FG.faint}>{"░".repeat(empty)}</Text>
    </>
  );
}

export function UsageCard({ card }: { card: UsageCardData }): React.ReactElement {
  if (card.compact) return <CompactUsageRow card={card} />;
  const cap = Math.max(1, card.tokens.promptCap);
  const promptRatio = card.tokens.prompt / cap;
  const reasonRatio = card.tokens.reason / cap;
  const outputRatio = card.tokens.output / cap;
  const elapsed = card.elapsedMs !== undefined ? ` · ${(card.elapsedMs / 1000).toFixed(1)}s` : "";
  const meta = `${formatCNY(card.cost)}${elapsed}`;

  return (
    <Box flexDirection="column">
      <CardHeader tone="usage" glyph="Σ" title="Usage" subtitle={`turn ${card.turn}`} meta={meta} />
      <BarRow tone="usage" indent={0} />
      <BarRow tone="usage">
        <Text color={FG.sub}>{"prompt    "}</Text>
        {bar(promptRatio, TONE.brand)}
        <Text bold color={FG.body}>{`  ${card.tokens.prompt.toLocaleString()}`}</Text>
        <Text color={FG.faint}>{` / 1M · ${(promptRatio * 100).toFixed(1)}%`}</Text>
      </BarRow>
      <BarRow tone="usage">
        <Text color={FG.sub}>{"reason    "}</Text>
        {bar(reasonRatio, TONE.accent)}
        <Text bold color={FG.body}>{`  ${card.tokens.reason.toLocaleString()}`}</Text>
      </BarRow>
      <BarRow tone="usage">
        <Text color={FG.sub}>{"output    "}</Text>
        {bar(outputRatio, TONE.brand)}
        <Text bold color={FG.body}>{`  ${card.tokens.output.toLocaleString()}`}</Text>
      </BarRow>
      <BarRow tone="usage" indent={0} />
      <BarRow tone="usage">
        <Text color={FG.sub}>{"cache hit "}</Text>
        {bar(card.cacheHit, TONE.ok)}
        <Text bold color={TONE.ok}>{`  ${(card.cacheHit * 100).toFixed(1)}%`}</Text>
      </BarRow>
      <BarRow tone="usage" indent={0} />
      <BarRow tone="usage">
        <Text color={FG.faint}>{"session "}</Text>
        <Text bold color={FG.body}>{`⛁ ${formatCNY(card.sessionCost, 3)}`}</Text>
        {card.balance !== undefined && (
          <>
            <Text color={FG.meta}>{"  ·  "}</Text>
            <Text color={FG.faint}>{"balance "}</Text>
            <Text bold color={TONE.brand}>{`¥${card.balance.toFixed(2)}`}</Text>
          </>
        )}
      </BarRow>
    </Box>
  );
}

function CompactUsageRow({ card }: { card: UsageCardData }): React.ReactElement {
  const elapsed = card.elapsedMs !== undefined ? `  ·  ${(card.elapsedMs / 1000).toFixed(1)}s` : "";
  return (
    <Box>
      <Text color={FG.faint}>{`  Σ  turn ${card.turn}  ·  `}</Text>
      <Text
        color={FG.meta}
      >{`${compactNum(card.tokens.prompt)} prompt · ${compactNum(card.tokens.output)} out`}</Text>
      <Text color={FG.faint}>{"  ·  cache "}</Text>
      <Text color={TONE.ok}>{`${(card.cacheHit * 100).toFixed(0)}%`}</Text>
      <Text color={FG.faint}>{`  ·  ${formatCNY(card.cost)}${elapsed}`}</Text>
      {card.balance !== undefined && (
        <>
          <Text color={FG.faint}>{"  ·  "}</Text>
          <Text color={TONE.brand}>{`¥${card.balance.toFixed(2)}`}</Text>
        </>
      )}
    </Box>
  );
}

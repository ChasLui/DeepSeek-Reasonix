import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Card as CardWrap } from "../primitives/Card.js";
import { CardHeader } from "../primitives/CardHeader.js";
import type { Card, SubAgentCard as SubAgentCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";

const STATUS_COLOR: Record<SubAgentCardData["status"], string> = {
  running: TONE.violet,
  done: TONE.ok,
  failed: TONE.err,
};

export function SubAgentCard({ card }: { card: SubAgentCardData }): React.ReactElement {
  const headColor = STATUS_COLOR[card.status];
  const headGlyph = card.status === "failed" ? "✖" : "⌬";
  return (
    <CardWrap tone={headColor}>
      <CardHeader
        glyph={headGlyph}
        tone={headColor}
        title="subagent"
        titleColor={TONE.violet}
        subtitle={card.name}
        meta={[{ text: card.status, color: headColor }]}
      />
      <Text color={FG.sub}>{card.task}</Text>
      {card.tools && card.tools.length > 0 && (
        <Text color={FG.faint}>{`tools · ${card.tools.join(", ")}`}</Text>
      )}
      {card.children.map((child) => (
        <Box key={child.id} flexDirection="row" gap={1}>
          <Text color={TONE.violet}>▎</Text>
          <ChildSummary card={child} />
        </Box>
      ))}
    </CardWrap>
  );
}

function ChildSummary({ card }: { card: Card }): React.ReactElement {
  switch (card.kind) {
    case "reasoning":
      return (
        <>
          <Text color={CARD.reasoning.color}>◆</Text>
          <Text italic color={FG.meta}>
            {`reasoning · ${card.paragraphs} paragraph${card.paragraphs === 1 ? "" : "s"}`}
          </Text>
        </>
      );
    case "tool":
      return (
        <>
          <Text color={CARD.tool.color}>▣</Text>
          <Text bold color={FG.body}>
            {card.name}
          </Text>
          {card.elapsedMs > 0 ? (
            <Text color={FG.faint}>{`· ${(card.elapsedMs / 1000).toFixed(2)}s`}</Text>
          ) : null}
        </>
      );
    case "streaming":
      return (
        <>
          <Text color={CARD.streaming.color}>◈</Text>
          <Text color={card.done ? FG.sub : TONE.brand}>
            {card.done ? "response" : "streaming response …"}
          </Text>
        </>
      );
    case "diff":
      return (
        <>
          <Text color={CARD.diff.color}>±</Text>
          <Text color={FG.sub}>{card.file}</Text>
        </>
      );
    case "error":
      return (
        <>
          <Text color={CARD.error.color}>✖</Text>
          <Text color={FG.sub}>{card.title}</Text>
        </>
      );
    default:
      return <Text color={FG.faint}>{`· ${card.kind}`}</Text>;
  }
}

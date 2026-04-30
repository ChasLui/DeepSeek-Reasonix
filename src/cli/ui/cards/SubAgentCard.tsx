import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { Card, SubAgentCard as SubAgentCardData } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const STATUS_COLOR: Record<SubAgentCardData["status"], string> = {
  running: TONE.violet,
  done: TONE.ok,
  failed: TONE.err,
};

export function SubAgentCard({ card }: { card: SubAgentCardData }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <CardHeader
        tone="subagent"
        glyph="⌬"
        title={`Sub-agent · ${card.name}`}
        trailing={<Text color={STATUS_COLOR[card.status]}>{card.status}</Text>}
      />
      <BarRow tone="subagent" indent={0} />
      <BarRow tone="subagent">
        <Text color={FG.faint}>{"Task   "}</Text>
        <Text color={FG.sub}>{card.task}</Text>
      </BarRow>
      {card.tools && card.tools.length > 0 && (
        <BarRow tone="subagent">
          <Text color={FG.faint}>{"Tools  "}</Text>
          <Text color={FG.sub}>{card.tools.join(", ")}</Text>
        </BarRow>
      )}
      {card.children.length > 0 && (
        <>
          <BarRow tone="subagent" indent={0} />
          <BarRow tone="subagent">
            <Text color={FG.meta}>{"sub-agent stream"}</Text>
          </BarRow>
          {card.children.map((child) => (
            <BarRow key={child.id} tone="subagent">
              <ChildSummary card={child} />
            </BarRow>
          ))}
        </>
      )}
    </Box>
  );
}

function ChildSummary({ card }: { card: Card }): React.ReactElement {
  switch (card.kind) {
    case "reasoning":
      return (
        <>
          <Text color={CARD.reasoning.color}>{"◆ "}</Text>
          <Text italic color={FG.meta}>
            {`Reasoning · ${card.paragraphs} paragraph${card.paragraphs === 1 ? "" : "s"}`}
          </Text>
        </>
      );
    case "tool":
      return (
        <>
          <Text color={CARD.tool.color}>{"▣ "}</Text>
          <Text bold color={FG.body}>
            {card.name}
          </Text>
          {card.elapsedMs > 0 && (
            <Text color={FG.faint}>{`   ${(card.elapsedMs / 1000).toFixed(2)}s`}</Text>
          )}
        </>
      );
    case "streaming":
      return (
        <>
          <Text color={CARD.streaming.color}>{"▶ "}</Text>
          <Text color={card.done ? FG.sub : TONE.brand}>
            {card.done ? "response" : "streaming response …"}
          </Text>
        </>
      );
    case "diff":
      return (
        <>
          <Text color={CARD.diff.color}>{"± "}</Text>
          <Text color={FG.sub}>{card.file}</Text>
        </>
      );
    case "error":
      return (
        <>
          <Text color={CARD.error.color}>{"✖ "}</Text>
          <Text color={FG.sub}>{card.title}</Text>
        </>
      );
    default:
      return <Text color={FG.faint}>{`· ${card.kind}`}</Text>;
  }
}

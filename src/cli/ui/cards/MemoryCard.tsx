import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { CardHeader } from "../primitives/CardHeader.js";
import type { MemoryCard as MemoryCardData, MemoryEntry } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";

const CATEGORY_ORDER: ReadonlyArray<MemoryEntry["category"]> = [
  "user",
  "feedback",
  "project",
  "reference",
];

const CATEGORY_LABEL: Record<MemoryEntry["category"], string> = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
};

const CATEGORY_GLYPH: Record<MemoryEntry["category"], string> = {
  user: "◇",
  feedback: "✦",
  project: "◇",
  reference: "→",
};

const CATEGORY_GLYPH_COLOR: Record<MemoryEntry["category"], string> = {
  user: FG.meta,
  feedback: TONE.warn,
  project: FG.meta,
  reference: TONE.info,
};

export function MemoryCard({ card }: { card: MemoryCardData }): React.ReactElement {
  const counts = countByCategory(card.entries);
  const summary = CATEGORY_ORDER.filter((c) => counts[c] > 0)
    .map((c) => `${counts[c]} ${c}`)
    .join(" · ");
  const tokens =
    card.tokens > 1024 ? `~${(card.tokens / 1024).toFixed(1)}K tok` : `~${card.tokens} tok`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <CardHeader
        glyph="⌑"
        tone={FG.meta}
        title="context"
        titleColor={FG.sub}
        meta={summary ? [summary, tokens] : [tokens]}
      />
      {CATEGORY_ORDER.filter((c) => counts[c] > 0).map((category) => {
        const all = card.entries.filter((e) => e.category === category);
        const shown = all.slice(0, 5);
        const remaining = all.length - shown.length;
        return (
          <Box key={category} flexDirection="column">
            <Box paddingLeft={2}>
              <Text color={FG.faint}>{`${CATEGORY_LABEL[category]} (${counts[category]})`}</Text>
            </Box>
            {shown.map((entry) => (
              <Box key={`${category}:${entry.summary}`} paddingLeft={2} flexDirection="row" gap={1}>
                <Text color={CATEGORY_GLYPH_COLOR[category]}>{CATEGORY_GLYPH[category]}</Text>
                <Text color={FG.sub}>{entry.summary}</Text>
              </Box>
            ))}
            {remaining > 0 ? (
              <Box paddingLeft={2}>
                <Text color={FG.faint}>{`⋮ +${remaining} more`}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function countByCategory(
  entries: ReadonlyArray<MemoryEntry>,
): Record<MemoryEntry["category"], number> {
  const out: Record<MemoryEntry["category"], number> = {
    user: 0,
    feedback: 0,
    project: 0,
    reference: 0,
  };
  for (const e of entries) out[e.category] += 1;
  return out;
}

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { CardHeader } from "../primitives/CardHeader.js";
import type { SearchCard as SearchCardData, SearchHit } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";

export function SearchCard({ card }: { card: SearchCardData }): React.ReactElement {
  const fileCount = new Set(card.hits.map((h) => h.file)).size;
  const elapsed = `${(card.elapsedMs / 1000).toFixed(2)}s`;
  const stats = `${card.hits.length} hit${card.hits.length === 1 ? "" : "s"} · ${fileCount} file${
    fileCount === 1 ? "" : "s"
  }`;

  const grouped = groupByFile(card.hits.slice(0, 10));

  return (
    <Box flexDirection="column" marginTop={1}>
      <CardHeader
        glyph="⊙"
        tone={TONE.info}
        title="search"
        subtitle={`"${card.query}"`}
        meta={[stats, elapsed]}
      />
      {grouped.map(([file, hits]) => (
        <Box key={file} flexDirection="column">
          <Box paddingLeft={2}>
            <Text bold color={FG.strong}>
              {file}
            </Text>
          </Box>
          {hits.map((h, i) => (
            <Box key={`${file}:${h.line}:${i}`} paddingLeft={2} flexDirection="row" gap={1}>
              <Text color={FG.faint}>{`${h.line.toString().padStart(4)} │`}</Text>
              <HighlightedLine text={h.preview} start={h.matchStart} end={h.matchEnd} />
            </Box>
          ))}
        </Box>
      ))}
      {card.hits.length > 10 ? (
        <Box paddingLeft={2}>
          <Text color={FG.faint}>{`⋮ +${card.hits.length - 10} more hits`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function HighlightedLine({
  text,
  start,
  end,
}: {
  text: string;
  start: number;
  end: number;
}): React.ReactElement {
  if (start < 0 || end <= start || end > text.length) {
    return <Text color={FG.sub}>{text}</Text>;
  }
  return (
    <>
      <Text color={FG.sub}>{text.slice(0, start)}</Text>
      <Text bold inverse>
        {text.slice(start, end)}
      </Text>
      <Text color={FG.sub}>{text.slice(end)}</Text>
    </>
  );
}

function groupByFile(hits: ReadonlyArray<SearchHit>): Array<[string, SearchHit[]]> {
  const map = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const list = map.get(h.file) ?? [];
    list.push(h);
    map.set(h.file, list);
  }
  return Array.from(map.entries());
}

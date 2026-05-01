import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { SearchCard as SearchCardData, SearchHit } from "../state/cards.js";
import { FG } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

export function SearchCard({ card }: { card: SearchCardData }): React.ReactElement {
  const fileCount = new Set(card.hits.map((h) => h.file)).size;
  const meta = `${card.hits.length} hit${card.hits.length === 1 ? "" : "s"} in ${fileCount} file${
    fileCount === 1 ? "" : "s"
  } · ${(card.elapsedMs / 1000).toFixed(2)}s`;

  return (
    <Box flexDirection="column">
      <CardHeader tone="search" glyph="⊙" title="Search" subtitle={`"${card.query}"`} meta={meta} />
      {card.hits.length > 0 && (
        <>
          <BarRow tone="search" indent={0} />
          {groupByFile(card.hits.slice(0, 10)).map(([file, hits]) => (
            <Box key={file} flexDirection="column">
              <BarRow tone="search">
                <Text bold color={FG.strong}>
                  {file}
                </Text>
              </BarRow>
              {hits.map((h, i) => (
                <BarRow key={`${file}:${h.line}:${i}`} tone="search">
                  <Text color={FG.faint}>{`${h.line.toString().padStart(4)} │ `}</Text>
                  <HighlightedLine text={h.preview} start={h.matchStart} end={h.matchEnd} />
                </BarRow>
              ))}
            </Box>
          ))}
          {card.hits.length > 10 && (
            <BarRow tone="search">
              <Text color={FG.faint}>{`⋮ +${card.hits.length - 10} more hits`}</Text>
            </BarRow>
          )}
        </>
      )}
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

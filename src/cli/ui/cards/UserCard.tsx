import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Markdown } from "../markdown.js";
import type { UserCard as UserCardData } from "../state/cards.js";
import { FG } from "../theme/tokens.js";
import { formatRelativeTime } from "./time.js";

export function UserCard({ card }: { card: UserCardData }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>{"  "}</Text>
        <Text color={FG.meta}>◇</Text>
        <Text bold color={FG.sub}>
          {" you"}
        </Text>
        <Text color={FG.faint}>{`  · ${formatRelativeTime(card.ts)}`}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={4}>
        <Markdown text={card.text} />
      </Box>
    </Box>
  );
}

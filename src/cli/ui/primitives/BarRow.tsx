import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { STRUCT } from "../cards/glyphs.js";
import { CARD, type CardTone } from "../theme/tokens.js";
import { useTick } from "../ticker.js";

export interface BarRowProps {
  tone: CardTone;
  glyph?: string;
  glyphBold?: boolean;
  indent?: 0 | 3;
  children?: React.ReactNode;
}

export function BarRow({
  tone,
  glyph,
  glyphBold = true,
  indent = 3,
  children,
}: BarRowProps): React.ReactElement {
  const t = CARD[tone];
  return (
    <Box flexDirection="row">
      <Text>{"  "}</Text>
      <Text color={t.color}>{STRUCT.bar}</Text>
      {glyph !== undefined ? (
        <Text bold={glyphBold} color={t.color}>
          {" "}
          {glyph}
          {indent === 3 ? "  " : " "}
        </Text>
      ) : indent > 0 ? (
        <Text>{" ".repeat(indent + 1)}</Text>
      ) : null}
      {children}
    </Box>
  );
}

export function CursorBlock(): React.ReactElement {
  const tick = useTick();
  const on = Math.floor(tick / 4) % 2 === 0;
  return (
    <Text inverse={on} color={CARD.streaming.color}>
      {" "}
    </Text>
  );
}

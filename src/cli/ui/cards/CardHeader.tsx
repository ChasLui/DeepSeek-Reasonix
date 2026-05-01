import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { CARD, type CardTone, FG } from "../theme/tokens.js";
import { STRUCT } from "./glyphs.js";

export interface CardHeaderProps {
  tone: CardTone;
  glyph: string;
  /** Bold + colored heading text right after the glyph. */
  title: string;
  /** Dimmed continuation appended after the title (e.g. "  src/cli/ui/App.tsx"). */
  subtitle?: string;
  /** Right-aligned dim meta (e.g. "0.08s · 1224 lines"). */
  meta?: string;
  /** Right-aligned colored badge slot, painted after `meta` (e.g. running/done badge). */
  trailing?: React.ReactNode;
  /** Inline node painted between the title and the subtitle — for spinners etc. */
  inline?: React.ReactNode;
  /** Override the bar color (default = card tone color). */
  barColor?: string;
  /** Override the title color (default = strong fg). User card uses sub fg. */
  titleColor?: string;
}

export function CardHeader({
  tone,
  glyph,
  title,
  subtitle,
  meta,
  trailing,
  inline,
  barColor,
  titleColor,
}: CardHeaderProps): React.ReactElement {
  const t = CARD[tone];
  const bar = barColor ?? t.color;
  return (
    <Box flexDirection="row">
      <Text>{"  "}</Text>
      <Text color={bar}>{STRUCT.bar}</Text>
      <Text> </Text>
      <Text bold color={t.color}>
        {glyph}
      </Text>
      <Text bold color={titleColor ?? FG.strong}>
        {` ${title}`}
      </Text>
      {inline && (
        <>
          <Text> </Text>
          {inline}
        </>
      )}
      {subtitle && <Text color={FG.sub}>{`  ${subtitle}`}</Text>}
      <Box flexGrow={1} />
      {meta && <Text color={FG.faint}>{meta}</Text>}
      {trailing && (
        <>
          <Text> </Text>
          {trailing}
        </>
      )}
    </Box>
  );
}

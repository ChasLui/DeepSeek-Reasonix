import { Box, Spacer, Text } from "ink";
import React from "react";
import { CARD, type CardTone, FG } from "../theme/tokens.js";
import { STATUS, STRUCT } from "./glyphs.js";

const CardToneCtx = React.createContext<CardTone>("user");

export interface CardProps {
  tone: CardTone;
  glyph?: string;
  title?: string;
  meta?: string;
  collapsed?: boolean;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}

export function Card({
  tone,
  glyph,
  title,
  meta,
  collapsed,
  trailing,
  children,
}: CardProps): React.ReactElement {
  const t = CARD[tone];
  const headerGlyph = glyph ?? t.glyph;
  const showBar = tone !== "user";

  return (
    <CardToneCtx.Provider value={tone}>
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>{"  "}</Text>
          {showBar ? <Text color={t.color}>{STRUCT.bar}</Text> : <Text> </Text>}
          <Text> </Text>
          <Text bold color={t.color}>
            {headerGlyph}
          </Text>
          {title !== undefined && (
            <Text bold color={tone === "user" ? FG.sub : FG.strong}>
              {" "}
              {title}
            </Text>
          )}
          <Spacer />
          {meta !== undefined && <Text color={FG.meta}>{meta}</Text>}
          {trailing !== undefined && (
            <>
              <Text> </Text>
              {trailing}
            </>
          )}
          {collapsed !== undefined && (
            <Text color={FG.faint}>
              {"  "}
              {collapsed ? STATUS.collapsed : STATUS.expanded}
            </Text>
          )}
        </Box>
        {children}
      </Box>
    </CardToneCtx.Provider>
  );
}

export function CardLine({
  children,
}: {
  children?: React.ReactNode;
}): React.ReactElement {
  const tone = React.useContext(CardToneCtx);
  const t = CARD[tone];
  const showBar = tone !== "user";
  return (
    <Box flexDirection="row">
      <Text>{"  "}</Text>
      {showBar ? <Text color={t.color}>{STRUCT.bar}</Text> : <Text> </Text>}
      <Text>{"   "}</Text>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

export function CardSpacer(): React.ReactElement {
  const tone = React.useContext(CardToneCtx);
  const t = CARD[tone];
  const showBar = tone !== "user";
  return (
    <Box flexDirection="row">
      <Text>{"  "}</Text>
      {showBar ? <Text color={t.color}>{STRUCT.bar}</Text> : <Text> </Text>}
    </Box>
  );
}

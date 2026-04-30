/** Empty-session welcome card — sharp ASCII box + tagline + 4 starter slash commands. */

import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { FG, TONE } from "./theme/tokens.js";

export interface WelcomeBannerProps {
  /** True when running `reasonix code`. Surfaces code-mode hints. */
  inCodeMode?: boolean;
  /** Live URL of the embedded dashboard, or null when it isn't running. */
  dashboardUrl?: string | null;
}

const TAGLINE_CHAT = "DeepSeek-native agent";
const TAGLINE_CODE = "DeepSeek-native coding agent";
const TAGLINE_SUB = "cache-first · flash-first";
const HINTS = ["/help", "/init", "/memory", "/cost"] as const;
const BOX_INNER_WIDTH = 35;

export function WelcomeBanner({
  inCodeMode,
  dashboardUrl,
}: WelcomeBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const tagline = inCodeMode ? TAGLINE_CODE : TAGLINE_CHAT;
  const boxWidth = BOX_INNER_WIDTH + 2;
  const boxIndent = Math.max(2, Math.floor((cols - boxWidth) / 2));
  const top = `╔${"═".repeat(BOX_INNER_WIDTH)}╗`;
  const bot = `╚${"═".repeat(BOX_INNER_WIDTH)}╝`;
  const hintsRow = HINTS.join("   ·   ");
  const hintsIndent = Math.max(2, Math.floor((cols - hintsRow.length) / 2));
  const startTextRaw = "type a message to start your session";
  const startIndent = Math.max(2, Math.floor((cols - startTextRaw.length) / 2));

  return (
    <Box flexDirection="column" marginY={1}>
      <BoxRow indent={boxIndent}>
        <Text color={TONE.brand}>{top}</Text>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>{""}</BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>
          <Text bold color={TONE.brand}>
            {centerInside("◈  REASONIX", BOX_INNER_WIDTH)}
          </Text>
        </BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>{""}</BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>
          <Text color={FG.sub}>{centerInside(tagline, BOX_INNER_WIDTH)}</Text>
        </BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>
          <Text color={FG.meta}>{centerInside(TAGLINE_SUB, BOX_INNER_WIDTH)}</Text>
        </BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <BoxLine pad={BOX_INNER_WIDTH}>{""}</BoxLine>
      </BoxRow>
      <BoxRow indent={boxIndent}>
        <Text color={TONE.brand}>{bot}</Text>
      </BoxRow>

      <Box marginTop={1}>
        <Text>{" ".repeat(startIndent)}</Text>
        <Text color={FG.sub}>{startTextRaw}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>{" ".repeat(hintsIndent)}</Text>
        {HINTS.map((cmd, i) => (
          <React.Fragment key={cmd}>
            <Text color={FG.meta}>{cmd}</Text>
            {i < HINTS.length - 1 && <Text color={FG.faint}>{"   ·   "}</Text>}
          </React.Fragment>
        ))}
      </Box>

      {dashboardUrl ? (
        <Box marginTop={1} flexDirection="row" justifyContent="center">
          <Text color={TONE.brand} bold>
            {"▸ web · "}
          </Text>
          <Text color={TONE.accent}>{dashboardUrl}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function BoxRow({
  indent,
  children,
}: {
  indent: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text>{" ".repeat(indent)}</Text>
      {children}
    </Box>
  );
}

function BoxLine({
  pad,
  children,
}: {
  pad: number;
  children?: React.ReactNode;
}): React.ReactElement {
  if (children === "" || children === undefined) {
    return (
      <>
        <Text color={TONE.brand}>{"║"}</Text>
        <Text>{" ".repeat(pad)}</Text>
        <Text color={TONE.brand}>{"║"}</Text>
      </>
    );
  }
  return (
    <>
      <Text color={TONE.brand}>{"║"}</Text>
      {children}
      <Text color={TONE.brand}>{"║"}</Text>
    </>
  );
}

function centerInside(text: string, pad: number): string {
  if (text.length >= pad) return text.slice(0, pad);
  const left = Math.floor((pad - text.length) / 2);
  const right = pad - text.length - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

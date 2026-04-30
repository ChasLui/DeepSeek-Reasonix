import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { BarRow } from "../primitives/BarRow.js";
import type { DoctorCard as DoctorCardData, DoctorCheckEntry } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";
import { CardHeader } from "./CardHeader.js";

const LEVEL_COLOR: Record<DoctorCheckEntry["level"], string> = {
  ok: TONE.ok,
  warn: TONE.warn,
  fail: TONE.err,
};

const LEVEL_GLYPH: Record<DoctorCheckEntry["level"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

const LEVEL_TAG: Record<DoctorCheckEntry["level"], string> = {
  ok: "OK",
  warn: "warn",
  fail: "FAIL",
};

export function DoctorCard({ card }: { card: DoctorCardData }): React.ReactElement {
  const ok = card.checks.filter((c) => c.level === "ok").length;
  const warn = card.checks.filter((c) => c.level === "warn").length;
  const fail = card.checks.filter((c) => c.level === "fail").length;
  const summary = `${card.checks.length} checks · ${ok} passed${warn > 0 ? ` · ${warn} warn` : ""}${fail > 0 ? ` · ${fail} fail` : ""}`;
  const labelWidth = card.checks.reduce((m, c) => Math.max(m, c.label.length), 0);

  return (
    <Box flexDirection="column">
      <CardHeader tone="tool" glyph="⚕" title="Doctor" meta={summary} barColor={CARD.tool.color} />
      <BarRow tone="tool" indent={0} />
      {card.checks.map((c) => (
        <BarRow key={c.label} tone="tool">
          <Text color={LEVEL_COLOR[c.level]}>{LEVEL_GLYPH[c.level]}</Text>
          <Text bold color={FG.body}>{`  ${c.label.padEnd(labelWidth + 1)}`}</Text>
          <Text color={FG.sub}>{c.detail}</Text>
          <Text color={LEVEL_COLOR[c.level]}>{`    ${LEVEL_TAG[c.level]}`}</Text>
        </BarRow>
      ))}
    </Box>
  );
}

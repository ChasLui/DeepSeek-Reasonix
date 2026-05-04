import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Card } from "../primitives/Card.js";
import { CardHeader } from "../primitives/CardHeader.js";
import type { DoctorCard as DoctorCardData, DoctorCheckEntry } from "../state/cards.js";
import { CARD, FG, TONE } from "../theme/tokens.js";

const LEVEL_COLOR: Record<DoctorCheckEntry["level"], string> = {
  ok: TONE.ok,
  warn: TONE.warn,
  fail: TONE.err,
};

const LEVEL_GLYPH: Record<DoctorCheckEntry["level"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✖",
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
  const labelWidth = card.checks.reduce((m, c) => Math.max(m, c.label.length), 0);
  const summary = `${card.checks.length} checks · ${ok} passed${warn > 0 ? ` · ${warn} warn` : ""}${fail > 0 ? ` · ${fail} fail` : ""}`;

  return (
    <Card tone={CARD.tool.color}>
      <CardHeader glyph="⚕" tone={CARD.tool.color} title="doctor" meta={[summary]} />
      {card.checks.map((c) => (
        <Box key={c.label} flexDirection="row" gap={1}>
          <Text color={LEVEL_COLOR[c.level]}>{LEVEL_GLYPH[c.level]}</Text>
          <Text bold color={FG.body}>
            {c.label.padEnd(labelWidth + 1)}
          </Text>
          <Text color={FG.sub}>{c.detail}</Text>
          <Text color={LEVEL_COLOR[c.level]}>{LEVEL_TAG[c.level]}</Text>
        </Box>
      ))}
    </Card>
  );
}

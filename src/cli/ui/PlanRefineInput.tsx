import { Box, Text } from "ink";
import React, { useState } from "react";
import { ApprovalCard, type ApprovalCardProps } from "./cards/ApprovalCard.js";
import { useKeystroke } from "./keystroke-context.js";
import { CARD, FG } from "./theme/tokens.js";
import { useTick } from "./ticker.js";

export interface PlanRefineInputProps {
  mode: "approve" | "refine" | "checkpoint-revise" | "choice-custom";
  onSubmit: (feedback: string) => void;
  onCancel: () => void;
}

interface ModeMeta {
  title: string;
  glyph: string;
  tone: ApprovalCardProps["tone"];
  cursorColor: string;
  hint: string;
  blankHint: string;
}

const MODES: Record<PlanRefineInputProps["mode"], ModeMeta> = {
  approve: {
    title: "approving — any last instructions?",
    glyph: "◇",
    tone: "user",
    cursorColor: CARD.user.color,
    hint: "Answer questions the plan raised, add constraints, or just press Enter to approve as-is.",
    blankHint: " (Enter with blank = approve without extra instructions.)",
  },
  refine: {
    title: "refining — what should the model change?",
    glyph: "✎",
    tone: "warn",
    cursorColor: CARD.warn.color,
    hint: "Describe what's wrong or missing, or answer questions the plan raised.",
    blankHint: " (Enter with blank = ask the model to list concrete questions.)",
  },
  "checkpoint-revise": {
    title: "revising — what should change before the next step?",
    glyph: "✎",
    tone: "warn",
    cursorColor: CARD.warn.color,
    hint: "Scope change, skip steps, alternative approach — the model adjusts the remaining plan.",
    blankHint: " (Enter with blank = continue with the current plan.)",
  },
  "choice-custom": {
    title: "custom answer — type whatever fits",
    glyph: "⌥",
    tone: "accent",
    cursorColor: CARD.plan.color,
    hint: "Free-form reply. The model reads it verbatim and proceeds — no need to match the listed options.",
    blankHint: " (Enter with blank = ask the model what you actually want.)",
  },
};

export function PlanRefineInput({ mode, onSubmit, onCancel }: PlanRefineInputProps) {
  const [value, setValue] = useState("");

  useKeystroke((ev) => {
    if (ev.paste) {
      setValue((v) => v + ev.input.replace(/\r?\n/g, " "));
      return;
    }
    if (ev.escape) {
      onCancel();
      return;
    }
    if (ev.return) {
      onSubmit(value.trim());
      return;
    }
    if (ev.backspace || ev.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (ev.input && !ev.ctrl && !ev.meta) {
      setValue((v) => v + ev.input);
    }
  });

  const tick = useTick();
  const cursorOn = Math.floor(tick / 4) % 2 === 0;
  const meta = MODES[mode];

  return (
    <ApprovalCard
      tone={meta.tone}
      glyph={meta.glyph}
      title={meta.title}
      footerHint="⏎ send  ·  esc return to picker"
    >
      <Box marginBottom={1}>
        <Text color={FG.sub}>
          {meta.hint}
          {value === "" ? meta.blankHint : ""}
        </Text>
      </Box>
      <Box>
        <Text color={meta.cursorColor} bold>
          {"› "}
        </Text>
        <Text>{value}</Text>
        <Text color={meta.cursorColor} bold>
          {cursorOn ? "▍" : " "}
        </Text>
      </Box>
    </ApprovalCard>
  );
}

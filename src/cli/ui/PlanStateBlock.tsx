/**
 * Shared Ink block that renders a TypedPlanState. Used by RecordView in
 * replay/diff TUIs.
 *
 * Colors are semantic (not decorative):
 *   - subgoals:       cyan         — structure / plan
 *   - hypotheses:     green        — current beliefs (like assistant)
 *   - uncertainties:  yellow       — attention required (like tool)
 *   - rejected paths: red dim      — ruled out (muted, like error-but-resolved)
 *
 * Visual: colored bold label + count, then dim items. No solid-bg pill
 * — every assistant turn surfaces this block, so the bracket-text style
 * keeps it from shouting four colored bg blocks at the user every turn.
 * Color alone (the bold label) is enough to identify the field type.
 */

import { Box, Text } from "ink";
import React from "react";
import type { TypedPlanState } from "../../harvest.js";
import { COLOR } from "./theme.js";

type FieldColor = string;

export function PlanStateBlock({ planState }: { planState: TypedPlanState }) {
  const fields: Array<[string, string[], FieldColor, boolean]> = [];
  if (planState.subgoals.length)
    fields.push(["subgoals", planState.subgoals, COLOR.primary, false]);
  if (planState.hypotheses.length)
    fields.push(["hypotheses", planState.hypotheses, COLOR.assistant, false]);
  if (planState.uncertainties.length)
    fields.push(["uncertainties", planState.uncertainties, COLOR.warn, false]);
  if (planState.rejectedPaths.length)
    fields.push(["rejected", planState.rejectedPaths, COLOR.info, true]);
  if (fields.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {fields.map(([label, items, color, dim]) => (
        <Box key={label}>
          <Text color={color} bold dimColor={dim}>
            {label}
          </Text>
          <Text dimColor>{` (${items.length})`}</Text>
          <Text dimColor>{"  · "}</Text>
          <Text dimColor={dim} color={dim ? undefined : COLOR.info}>
            {items.join(" · ")}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

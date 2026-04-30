import { Box, Text } from "ink";
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";

export type ReviseChoice = "accept" | "reject";

export interface PlanReviseConfirmProps {
  reason: string;
  oldRemaining: PlanStep[];
  newRemaining: PlanStep[];
  summary?: string;
  onChoose: (choice: ReviseChoice) => void;
}

interface DiffRow {
  kind: "kept" | "removed" | "added";
  step: PlanStep;
}

function computeDiff(oldSteps: PlanStep[], newSteps: PlanStep[]): DiffRow[] {
  const oldIds = new Set(oldSteps.map((s) => s.id));
  const newIds = new Set(newSteps.map((s) => s.id));
  const rows: DiffRow[] = [];
  for (const s of oldSteps) {
    if (!newIds.has(s.id)) rows.push({ kind: "removed", step: s });
  }
  for (const s of newSteps) {
    rows.push({ kind: oldIds.has(s.id) ? "kept" : "added", step: s });
  }
  return rows;
}

function riskDots(risk: PlanStep["risk"]): { dots: string; color: string } {
  switch (risk) {
    case "high":
      return { dots: "●●●", color: "#f87171" };
    case "med":
      return { dots: "●● ", color: "#fbbf24" };
    case "low":
      return { dots: "●  ", color: "#4ade80" };
    default:
      return { dots: "   ", color: "#94a3b8" };
  }
}

function PlanReviseConfirmInner({
  reason,
  oldRemaining,
  newRemaining,
  summary,
  onChoose,
}: PlanReviseConfirmProps) {
  const rows = computeDiff(oldRemaining, newRemaining);
  const removedCount = rows.filter((r) => r.kind === "removed").length;
  const addedCount = rows.filter((r) => r.kind === "added").length;
  const keptCount = rows.filter((r) => r.kind === "kept").length;
  return (
    <ApprovalCard
      tone="warn"
      glyph="✏"
      title="plan revision proposed"
      metaRight={`−${removedCount}  +${addedCount}  ·  ${keptCount} kept`}
    >
      <Box marginBottom={1}>
        <Text>{reason}</Text>
      </Box>
      {summary ? (
        <Box marginBottom={1}>
          <Text dimColor>{`updated summary: ${summary}`}</Text>
        </Box>
      ) : null}
      <Box marginBottom={1} flexDirection="column">
        {rows.map((row) => {
          const risk = riskDots(row.step.risk);
          const prefix = row.kind === "removed" ? "−" : row.kind === "added" ? "+" : " ";
          const prefixColor =
            row.kind === "removed" ? "#f87171" : row.kind === "added" ? "#4ade80" : "#94a3b8";
          const dim = row.kind === "kept";
          const strike = row.kind === "removed";
          return (
            <Box key={`${row.kind}-${row.step.id}`}>
              <Text color={prefixColor} bold>
                {`${prefix} `}
              </Text>
              <Text color={risk.color} bold dimColor={dim}>
                {risk.dots}
              </Text>
              <Text dimColor={dim} strikethrough={strike}>
                {` ${row.step.id} · ${row.step.title}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <SingleSelect
        initialValue="accept"
        items={[
          {
            value: "accept",
            label: "Accept revision — apply the new step list",
            hint: "Replaces the remaining plan with the proposed steps. Done steps are untouched.",
          },
          {
            value: "reject",
            label: "Reject — keep the original plan",
            hint: "Drops the proposal. Model continues with the original remaining steps.",
          },
        ]}
        onSubmit={(v) => onChoose(v as ReviseChoice)}
        onCancel={() => onChoose("reject")}
      />
    </ApprovalCard>
  );
}

export const PlanReviseConfirm = React.memo(PlanReviseConfirmInner);

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { SingleSelect } from "./Select.js";
import { ApprovalCard } from "./cards/ApprovalCard.js";
import { FG, TONE } from "./theme/tokens.js";

export type WorkspaceConfirmChoice = "archive" | "discard" | "cancel";

export interface WorkspaceConfirmProps {
  /** Resolved absolute path the model wants to switch to. */
  path: string;
  /** Current session root, shown above the target so the user sees the diff. */
  currentRoot: string;
  /** Number of MCP servers still attached. */
  mcpServerCount: number;
  /** Drives the archive-vs-discard warning text; null = no active plan. */
  planProgress: { done: number; total: number } | null;
  onChoose: (choice: WorkspaceConfirmChoice) => void;
}

export function WorkspaceConfirm({
  path,
  currentRoot,
  mcpServerCount,
  planProgress,
  onChoose,
}: WorkspaceConfirmProps) {
  const subtitle =
    mcpServerCount > 0
      ? `MCP servers (${mcpServerCount}) stay anchored to the original launch root.`
      : "Re-registers filesystem / shell / memory tools at the new path.";

  const planLine = planProgress
    ? `Switching ends the current session. Plan progress (${planProgress.done} of ${planProgress.total} done) will be archived; you can replay it later via /replay.`
    : "Switching re-roots filesystem / shell / memory tools.";

  return (
    <ApprovalCard
      tone="warn"
      glyph="?"
      title="Switch workspace"
      metaRight="awaiting"
      footerHint="↑↓ pick  ·  ⏎ confirm  ·  esc cancel"
    >
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={FG.faint}>{"current   "}</Text>
          <Text bold color={FG.body}>
            {currentRoot}
          </Text>
        </Box>
        <Box>
          <Text color={FG.faint}>{"new       "}</Text>
          <Text bold color={TONE.warn}>
            {path}
          </Text>
        </Box>
      </Box>
      <Box marginBottom={1}>
        <Text color={FG.sub}>{planLine}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={FG.faint}>{subtitle}</Text>
      </Box>
      <SingleSelect
        initialValue={planProgress ? "archive" : "discard"}
        items={[
          {
            value: "archive",
            label: "open & archive plan",
            hint: planProgress ? "recommended" : "no active plan to archive",
          },
          {
            value: "discard",
            label: "open & discard plan",
            hint: "throw away the snapshot",
          },
          {
            value: "cancel",
            label: "cancel",
            hint: "stay in this workspace",
          },
        ]}
        onSubmit={(v) => onChoose(v as WorkspaceConfirmChoice)}
        onCancel={() => onChoose("cancel")}
      />
    </ApprovalCard>
  );
}

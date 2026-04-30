import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { useAgentState } from "../state/provider.js";
import { FG, TONE } from "../theme/tokens.js";
import { StatusRow } from "./StatusRow.js";

const PLACEHOLDER = "type a message · / for commands · @ to attach a file";
const HINT = "⏎ send  ·  shift/alt+⏎ newline  ·  ↑↓ history  ·  esc abort  ·  ctrl-c quit";
const ABORTED_HINT = "turn aborted by user · esc again to clear · ⏎ to ask a follow-up";

export function Composer(): React.ReactElement {
  const composer = useAgentState((s) => s.composer);

  return (
    <Box flexDirection="column">
      <StatusRow />
      <Box height={1} />
      <Box flexDirection="row">
        <Text bold color={composer.shell ? TONE.err : TONE.brand}>
          {composer.shell ? "$" : "›"}{" "}
        </Text>
        {composer.value.length === 0 ? (
          <Text color={FG.meta}>{PLACEHOLDER}</Text>
        ) : (
          <Text color={FG.body}>{composer.value}</Text>
        )}
      </Box>
      <Box height={1} />
      <Text color={FG.faint}>
        {"  "}
        {composer.abortedHint ? ABORTED_HINT : HINT}
      </Text>
    </Box>
  );
}

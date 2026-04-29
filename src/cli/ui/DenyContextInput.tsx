/** Single-line text input for deny-with-reason — uses our KeystrokeContext, not ink-text-input. */

import { Box, Text } from "ink";
import React, { useState } from "react";
import { useKeystroke } from "./keystroke-context.js";

export interface DenyContextInputProps {
  label?: string;
  onSubmit: (context: string) => void;
  onCancel: () => void;
}

export function DenyContextInput({
  label = "Reason for denying:",
  onSubmit,
  onCancel,
}: DenyContextInputProps) {
  const [value, setValue] = useState("");

  useKeystroke((ev) => {
    if (ev.paste) return;
    if (ev.escape) {
      onCancel();
      return;
    }
    if (ev.return) {
      onSubmit(value);
      return;
    }
    if (ev.backspace) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (ev.input && !ev.tab && !ev.upArrow && !ev.downArrow && !ev.leftArrow && !ev.rightArrow) {
      setValue((v) => v + ev.input);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{label} </Text>
        <Text>{value}</Text>
        <Text backgroundColor="#67e8f9" color="black">
          {" "}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {"["}
          <Text color="#67e8f9" bold>
            Enter
          </Text>
          {"] confirm  ·  ["}
          <Text color="#67e8f9" bold>
            Esc
          </Text>
          {"] cancel"}
        </Text>
      </Box>
    </Box>
  );
}

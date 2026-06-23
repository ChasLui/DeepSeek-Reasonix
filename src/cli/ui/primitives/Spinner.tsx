import { Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { useTick } from "../ticker.js";

const FRAMES = {
  circle: ["◐", "◓", "◑", "◒"] as const,
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const,
};

export interface SpinnerProps {
  kind?: keyof typeof FRAMES | undefined;
  color?: string | undefined;
  bold?: boolean | undefined;
}

export function Spinner({ kind = "circle", color, bold }: SpinnerProps): React.ReactElement {
  const frames = FRAMES[kind];
  const tick = useTick();
  const frame = tick % frames.length;

  return (
    <Text {...(bold !== undefined ? { bold } : {})} {...(color !== undefined ? { color } : {})}>
      {frames[frame]}
    </Text>
  );
}

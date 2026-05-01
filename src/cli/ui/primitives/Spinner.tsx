import { Text } from "ink";
import React from "react";

const FRAMES = {
  circle: ["◐", "◓", "◑", "◒"] as const,
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const,
};

const CADENCE_MS = {
  circle: 200,
  braille: 80,
} as const;

export interface SpinnerProps {
  kind?: keyof typeof FRAMES;
  color?: string;
  bold?: boolean;
}

export function Spinner({ kind = "circle", color, bold }: SpinnerProps): React.ReactElement {
  const frames = FRAMES[kind];
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), CADENCE_MS[kind]);
    return () => clearInterval(id);
  }, [kind, frames.length]);

  return (
    <Text bold={bold} color={color}>
      {frames[frame]}
    </Text>
  );
}

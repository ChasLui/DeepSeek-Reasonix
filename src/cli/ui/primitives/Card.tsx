import { Box } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";

export interface CardProps {
  tone: string;
  children: React.ReactNode;
}

export function Card({ tone, children }: CardProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1} marginTop={1}>
      {children}
    </Box>
  );
}

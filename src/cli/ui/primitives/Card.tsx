import { Box } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { useContext } from "react";

/** Settled cards (in scrollback) drop the border + paddingX so history reads as flat lines. */
export const ActiveCardContext = React.createContext(true);

export interface CardProps {
  tone: string;
  children: React.ReactNode;
}

export function Card({ tone, children }: CardProps): React.ReactElement {
  const active = useContext(ActiveCardContext);
  if (!active) {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {children}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tone}
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      {children}
    </Box>
  );
}

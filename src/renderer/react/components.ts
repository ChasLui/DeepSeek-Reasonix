import React, { type ReactElement, type ReactNode } from "react";
import type { BorderStyle, BorderStyleName } from "../layout/borders.js";
import type { AlignItems, FlexWrap, JustifyContent } from "../layout/node.js";
import type { AnsiCode } from "../pools/style-pool.js";

export const HOST_BOX = "rsx-box" as const;
export const HOST_TEXT = "rsx-text" as const;

export interface BoxProps {
  readonly children?: ReactNode;
  readonly flexDirection?: "column" | "row" | "column-reverse" | "row-reverse";
  readonly flexGrow?: number;
  readonly flexShrink?: number;
  readonly flexBasis?: number | `${number}%` | "auto";
  readonly flexWrap?: FlexWrap;
  readonly justifyContent?: JustifyContent;
  readonly alignItems?: AlignItems;
  readonly alignSelf?: AlignItems;
  readonly alignContent?: AlignItems | "space-between" | "space-around";
  readonly width?: number | `${number}%`;
  readonly height?: number | `${number}%`;
  readonly minWidth?: number | `${number}%`;
  readonly minHeight?: number | `${number}%`;
  readonly maxWidth?: number | `${number}%`;
  readonly maxHeight?: number | `${number}%`;
  readonly gap?: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
  readonly display?: "flex" | "none";
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly paddingRight?: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly padding?: number;
  readonly marginTop?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly marginRight?: number;
  readonly marginX?: number;
  readonly marginY?: number;
  readonly margin?: number;
  readonly borderStyle?: BorderStyle | BorderStyleName;
  readonly borderTop?: boolean;
  readonly borderBottom?: boolean;
  readonly borderLeft?: boolean;
  readonly borderRight?: boolean;
  readonly borderColor?: ReadonlyArray<AnsiCode>;
  readonly borderTopColor?: ReadonlyArray<AnsiCode>;
  readonly borderBottomColor?: ReadonlyArray<AnsiCode>;
  readonly borderLeftColor?: ReadonlyArray<AnsiCode>;
  readonly borderRightColor?: ReadonlyArray<AnsiCode>;
}

export interface TextProps {
  readonly children?: ReactNode;
  readonly style?: ReadonlyArray<AnsiCode>;
  readonly hyperlink?: string;
}

export function Box(props: BoxProps): ReactElement {
  return React.createElement(HOST_BOX, props);
}

export function Text(props: TextProps): ReactElement {
  return React.createElement(HOST_TEXT, props);
}

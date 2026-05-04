import type { AnsiCode } from "../pools/style-pool.js";
import type { BorderStyle, BorderStyleName } from "./borders.js";

export interface TextNode {
  readonly kind: "text";
  readonly content: string;
  readonly style?: ReadonlyArray<AnsiCode>;
  readonly hyperlink?: string;
}

export type JustifyContent =
  | "flex-start"
  | "flex-end"
  | "center"
  | "space-between"
  | "space-around"
  | "space-evenly";

export type AlignItems = "flex-start" | "flex-end" | "center" | "stretch" | "baseline";

export type FlexWrap = "nowrap" | "wrap" | "wrap-reverse";

export type Display = "flex" | "none";

export interface BoxNode {
  readonly kind: "box";
  readonly children: ReadonlyArray<LayoutNode>;
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
  readonly display?: Display;
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly paddingRight?: number;
  readonly marginTop?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly marginRight?: number;
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

export type LayoutNode = TextNode | BoxNode;

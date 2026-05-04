import type { BoxNode, LayoutNode, TextNode } from "../layout/node.js";
import type { BoxProps, TextProps } from "../react/components.js";

export type HostType = "box" | "text" | "raw-text";

export interface HostBox {
  readonly type: "box";
  props: BoxProps;
  children: HostNode[];
  parent: HostBox | null;
}

export interface HostText {
  readonly type: "text";
  props: TextProps;
  children: HostNode[];
  parent: HostBox | null;
}

export interface HostRawText {
  readonly type: "raw-text";
  text: string;
  parent: HostBox | HostText | null;
}

export type HostNode = HostBox | HostText | HostRawText;

export function makeHostBox(props: BoxProps): HostBox {
  return { type: "box", props, children: [], parent: null };
}

export function makeHostText(props: TextProps): HostText {
  return { type: "text", props, children: [], parent: null };
}

export function makeHostRawText(text: string): HostRawText {
  return { type: "raw-text", text, parent: null };
}

export function hostToLayoutNode(node: HostNode): LayoutNode | null {
  if (node.type === "raw-text") {
    return { kind: "text", content: node.text };
  }
  if (node.type === "text") {
    return {
      kind: "text",
      content: collectText(node.children),
      ...(node.props.style ? { style: node.props.style } : {}),
      ...(node.props.hyperlink ? { hyperlink: node.props.hyperlink } : {}),
    } satisfies TextNode;
  }
  const layoutChildren: LayoutNode[] = [];
  for (const c of node.children) {
    const child = hostToLayoutNode(c);
    if (child) layoutChildren.push(child);
  }
  const p = node.props;
  const out: BoxNode = { kind: "box", children: layoutChildren };
  return assignBoxProps(out, p);
}

function collectText(children: HostNode[]): string {
  let out = "";
  for (const child of children) {
    if (child.type === "raw-text") out += child.text;
    else if (child.type === "text") out += collectText(child.children);
  }
  return out;
}

function assignBoxProps(node: BoxNode, props: BoxProps): BoxNode {
  const result: { -readonly [K in keyof BoxNode]: BoxNode[K] } = { ...node };

  // padding shorthand: padding > paddingX/Y > side-specific
  const padAll = props.padding;
  const padX = props.paddingX ?? padAll;
  const padY = props.paddingY ?? padAll;
  const padTop = props.paddingTop ?? padY;
  const padBottom = props.paddingBottom ?? padY;
  const padLeft = props.paddingLeft ?? padX;
  const padRight = props.paddingRight ?? padX;
  if (padTop !== undefined) result.paddingTop = padTop;
  if (padBottom !== undefined) result.paddingBottom = padBottom;
  if (padLeft !== undefined) result.paddingLeft = padLeft;
  if (padRight !== undefined) result.paddingRight = padRight;

  // margin shorthand: margin > marginX/Y > side-specific
  const marginAll = props.margin;
  const marginX = props.marginX ?? marginAll;
  const marginY = props.marginY ?? marginAll;
  const marginTop = props.marginTop ?? marginY;
  const marginBottom = props.marginBottom ?? marginY;
  const marginLeft = props.marginLeft ?? marginX;
  const marginRight = props.marginRight ?? marginX;
  if (marginTop !== undefined) result.marginTop = marginTop;
  if (marginBottom !== undefined) result.marginBottom = marginBottom;
  if (marginLeft !== undefined) result.marginLeft = marginLeft;
  if (marginRight !== undefined) result.marginRight = marginRight;

  if (props.flexDirection !== undefined) result.flexDirection = props.flexDirection;
  if (props.flexGrow !== undefined) result.flexGrow = props.flexGrow;
  if (props.flexShrink !== undefined) result.flexShrink = props.flexShrink;
  if (props.flexBasis !== undefined) result.flexBasis = props.flexBasis;
  if (props.flexWrap !== undefined) result.flexWrap = props.flexWrap;
  if (props.justifyContent !== undefined) result.justifyContent = props.justifyContent;
  if (props.alignItems !== undefined) result.alignItems = props.alignItems;
  if (props.alignSelf !== undefined) result.alignSelf = props.alignSelf;
  if (props.alignContent !== undefined) result.alignContent = props.alignContent;
  if (props.width !== undefined) result.width = props.width;
  if (props.height !== undefined) result.height = props.height;
  if (props.minWidth !== undefined) result.minWidth = props.minWidth;
  if (props.minHeight !== undefined) result.minHeight = props.minHeight;
  if (props.maxWidth !== undefined) result.maxWidth = props.maxWidth;
  if (props.maxHeight !== undefined) result.maxHeight = props.maxHeight;
  if (props.gap !== undefined) result.gap = props.gap;
  if (props.columnGap !== undefined) result.columnGap = props.columnGap;
  if (props.rowGap !== undefined) result.rowGap = props.rowGap;
  if (props.display !== undefined) result.display = props.display;

  if (props.borderStyle !== undefined) result.borderStyle = props.borderStyle;
  if (props.borderTop !== undefined) result.borderTop = props.borderTop;
  if (props.borderBottom !== undefined) result.borderBottom = props.borderBottom;
  if (props.borderLeft !== undefined) result.borderLeft = props.borderLeft;
  if (props.borderRight !== undefined) result.borderRight = props.borderRight;
  if (props.borderColor !== undefined) result.borderColor = props.borderColor;
  if (props.borderTopColor !== undefined) result.borderTopColor = props.borderTopColor;
  if (props.borderBottomColor !== undefined) result.borderBottomColor = props.borderBottomColor;
  if (props.borderLeftColor !== undefined) result.borderLeftColor = props.borderLeftColor;
  if (props.borderRightColor !== undefined) result.borderRightColor = props.borderRightColor;
  return result;
}

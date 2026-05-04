import { Fragment, type ReactElement, type ReactNode, isValidElement } from "react";
import { type RenderPools, renderToScreen } from "../layout/layout.js";
import type { BoxNode, LayoutNode, TextNode } from "../layout/node.js";
import type { Screen } from "../screen/screen.js";
import { type BoxProps, HOST_BOX, HOST_TEXT, type TextProps } from "./components.js";

export interface RenderOptions {
  readonly width: number;
  readonly pools: RenderPools;
}

export function render(element: ReactNode, opts: RenderOptions): Screen {
  const node = treeToLayoutNode(element) ?? emptyBox();
  return renderToScreen(node, opts.width, opts.pools);
}

function treeToLayoutNode(element: ReactNode): LayoutNode | null {
  if (element === null || element === undefined || typeof element === "boolean") return null;
  if (typeof element === "string" || typeof element === "number") {
    return { kind: "text", content: String(element) };
  }
  if (Array.isArray(element)) {
    const children = element.map(treeToLayoutNode).filter(notNull);
    return children.length > 0 ? { kind: "box", children } : null;
  }
  if (isValidElement(element)) {
    return elementToLayoutNode(element);
  }
  return null;
}

function elementToLayoutNode(element: ReactElement): LayoutNode | null {
  const type = element.type;
  const props = element.props as { children?: ReactNode };

  if (type === HOST_BOX) {
    const boxProps = element.props as BoxProps;
    const children = childrenToLayoutNodes(props.children);
    return assignAllBoxProps({ kind: "box", children }, boxProps);
  }

  if (type === HOST_TEXT) {
    const textProps = element.props as TextProps;
    return {
      kind: "text",
      content: collectText(textProps.children),
      ...(textProps.style ? { style: textProps.style } : {}),
      ...(textProps.hyperlink ? { hyperlink: textProps.hyperlink } : {}),
    } satisfies TextNode;
  }

  if (type === Fragment) {
    const children = childrenToLayoutNodes(props.children);
    return children.length === 1 ? children[0]! : { kind: "box", children };
  }

  if (typeof type === "function") {
    const Component = type as (props: unknown) => ReactNode;
    return treeToLayoutNode(Component(props));
  }

  return null;
}

function childrenToLayoutNodes(children: ReactNode): LayoutNode[] {
  if (children === null || children === undefined || typeof children === "boolean") return [];
  if (Array.isArray(children)) {
    return children.map(treeToLayoutNode).filter(notNull);
  }
  const node = treeToLayoutNode(children);
  return node ? [node] : [];
}

function collectText(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map(collectText).join("");
  }
  if (isValidElement(children)) {
    const inner = (children.props as { children?: ReactNode }).children;
    return collectText(inner);
  }
  return "";
}

function emptyBox(): BoxNode {
  return { kind: "box", children: [] };
}

function assignAllBoxProps(node: BoxNode, props: BoxProps): BoxNode {
  const r: { -readonly [K in keyof BoxNode]: BoxNode[K] } = { ...node };
  const padAll = props.padding;
  const padX = props.paddingX ?? padAll;
  const padY = props.paddingY ?? padAll;
  if ((props.paddingTop ?? padY) !== undefined) r.paddingTop = props.paddingTop ?? padY;
  if ((props.paddingBottom ?? padY) !== undefined) r.paddingBottom = props.paddingBottom ?? padY;
  if ((props.paddingLeft ?? padX) !== undefined) r.paddingLeft = props.paddingLeft ?? padX;
  if ((props.paddingRight ?? padX) !== undefined) r.paddingRight = props.paddingRight ?? padX;
  const marginAll = props.margin;
  const marginX = props.marginX ?? marginAll;
  const marginY = props.marginY ?? marginAll;
  if ((props.marginTop ?? marginY) !== undefined) r.marginTop = props.marginTop ?? marginY;
  if ((props.marginBottom ?? marginY) !== undefined) r.marginBottom = props.marginBottom ?? marginY;
  if ((props.marginLeft ?? marginX) !== undefined) r.marginLeft = props.marginLeft ?? marginX;
  if ((props.marginRight ?? marginX) !== undefined) r.marginRight = props.marginRight ?? marginX;
  if (props.flexDirection !== undefined) r.flexDirection = props.flexDirection;
  if (props.flexGrow !== undefined) r.flexGrow = props.flexGrow;
  if (props.flexShrink !== undefined) r.flexShrink = props.flexShrink;
  if (props.flexBasis !== undefined) r.flexBasis = props.flexBasis;
  if (props.flexWrap !== undefined) r.flexWrap = props.flexWrap;
  if (props.justifyContent !== undefined) r.justifyContent = props.justifyContent;
  if (props.alignItems !== undefined) r.alignItems = props.alignItems;
  if (props.alignSelf !== undefined) r.alignSelf = props.alignSelf;
  if (props.alignContent !== undefined) r.alignContent = props.alignContent;
  if (props.width !== undefined) r.width = props.width;
  if (props.height !== undefined) r.height = props.height;
  if (props.minWidth !== undefined) r.minWidth = props.minWidth;
  if (props.minHeight !== undefined) r.minHeight = props.minHeight;
  if (props.maxWidth !== undefined) r.maxWidth = props.maxWidth;
  if (props.maxHeight !== undefined) r.maxHeight = props.maxHeight;
  if (props.gap !== undefined) r.gap = props.gap;
  if (props.columnGap !== undefined) r.columnGap = props.columnGap;
  if (props.rowGap !== undefined) r.rowGap = props.rowGap;
  if (props.display !== undefined) r.display = props.display;
  if (props.borderStyle !== undefined) r.borderStyle = props.borderStyle;
  if (props.borderTop !== undefined) r.borderTop = props.borderTop;
  if (props.borderBottom !== undefined) r.borderBottom = props.borderBottom;
  if (props.borderLeft !== undefined) r.borderLeft = props.borderLeft;
  if (props.borderRight !== undefined) r.borderRight = props.borderRight;
  if (props.borderColor !== undefined) r.borderColor = props.borderColor;
  if (props.borderTopColor !== undefined) r.borderTopColor = props.borderTopColor;
  if (props.borderBottomColor !== undefined) r.borderBottomColor = props.borderBottomColor;
  if (props.borderLeftColor !== undefined) r.borderLeftColor = props.borderLeftColor;
  if (props.borderRightColor !== undefined) r.borderRightColor = props.borderRightColor;
  return r;
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

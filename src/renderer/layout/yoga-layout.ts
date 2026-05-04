import Yoga, {
  Align,
  BoxSizing,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  type MeasureFunction,
  type Node as YogaNode,
  Wrap,
} from "yoga-layout";
import type { CharPool } from "../pools/char-pool.js";
import type { HyperlinkPool } from "../pools/hyperlink-pool.js";
import type { StylePool } from "../pools/style-pool.js";
import { type BorderStyle, resolveBorderStyle } from "./borders.js";
import type { AlignItems, BoxNode, JustifyContent, LayoutNode, TextNode } from "./node.js";

export interface YogaPools {
  readonly char: CharPool;
  readonly style: StylePool;
  readonly hyperlink: HyperlinkPool;
}

export interface NodeMeta {
  readonly node: LayoutNode;
  readonly border?: BorderStyle;
  readonly useTop: boolean;
  readonly useBottom: boolean;
  readonly useLeft: boolean;
  readonly useRight: boolean;
  /** Text style/hyperlink interned at build time, applied during rasterization. */
  readonly styleId: number;
  readonly hyperlinkId: number;
}

export interface BuiltTree {
  readonly root: YogaNode;
  readonly meta: WeakMap<YogaNode, NodeMeta>;
  /** Children in tree order so the rasterizer can walk without yoga's own tree walk. */
  readonly children: ReadonlyMap<YogaNode, ReadonlyArray<YogaNode>>;
}

const ALIGN_MAP: Record<AlignItems, Align> = {
  "flex-start": Align.FlexStart,
  "flex-end": Align.FlexEnd,
  center: Align.Center,
  stretch: Align.Stretch,
  baseline: Align.Baseline,
};

const JUSTIFY_MAP: Record<JustifyContent, Justify> = {
  "flex-start": Justify.FlexStart,
  "flex-end": Justify.FlexEnd,
  center: Justify.Center,
  "space-between": Justify.SpaceBetween,
  "space-around": Justify.SpaceAround,
  "space-evenly": Justify.SpaceEvenly,
};

/** Build a yoga tree from a LayoutNode. Caller owns the root and must call freeRecursive(). */
export function buildYogaTree(
  node: LayoutNode,
  pools: YogaPools,
  measureText: (
    content: string,
    width: number,
    widthMode: MeasureMode,
  ) => { width: number; height: number },
): BuiltTree {
  const meta = new WeakMap<YogaNode, NodeMeta>();
  const children = new Map<YogaNode, YogaNode[]>();

  const root = build(node, pools, measureText, meta, children);
  return { root, meta, children };
}

function build(
  node: LayoutNode,
  pools: YogaPools,
  measureText: (
    content: string,
    width: number,
    widthMode: MeasureMode,
  ) => { width: number; height: number },
  meta: WeakMap<YogaNode, NodeMeta>,
  children: Map<YogaNode, YogaNode[]>,
): YogaNode {
  if (node.kind === "text") {
    return buildText(node, pools, measureText, meta);
  }
  return buildBox(node, pools, measureText, meta, children);
}

function buildText(
  node: TextNode,
  pools: YogaPools,
  measureText: (
    content: string,
    width: number,
    widthMode: MeasureMode,
  ) => { width: number; height: number },
  meta: WeakMap<YogaNode, NodeMeta>,
): YogaNode {
  const yoga = Yoga.Node.create();
  yoga.setBoxSizing(BoxSizing.BorderBox);
  // Yoga's default flex-shrink is 0; CSS (and Ink) default is 1. Match CSS so
  // long text wraps to fit narrower containers instead of overflowing.
  yoga.setFlexShrink(1);
  const measure: MeasureFunction = (width, widthMode) =>
    measureText(node.content, width, widthMode);
  yoga.setMeasureFunc(measure);

  const styleId = node.style ? pools.style.intern(node.style) : pools.style.none;
  const hyperlinkId = pools.hyperlink.intern(node.hyperlink);
  meta.set(yoga, {
    node,
    useTop: false,
    useBottom: false,
    useLeft: false,
    useRight: false,
    styleId,
    hyperlinkId,
  });
  return yoga;
}

function buildBox(
  node: BoxNode,
  pools: YogaPools,
  measureText: (
    content: string,
    width: number,
    widthMode: MeasureMode,
  ) => { width: number; height: number },
  meta: WeakMap<YogaNode, NodeMeta>,
  children: Map<YogaNode, YogaNode[]>,
): YogaNode {
  const yoga = Yoga.Node.create();
  yoga.setBoxSizing(BoxSizing.BorderBox);
  // Default shrink=1 to match CSS / Ink ergonomics — applyBoxStyle overrides if explicit.
  yoga.setFlexShrink(1);
  applyBoxStyle(yoga, node);

  const border = resolveBorderStyle(node.borderStyle);
  const useTop = border !== undefined && node.borderTop !== false;
  const useBottom = border !== undefined && node.borderBottom !== false;
  const useLeft = border !== undefined && node.borderLeft !== false;
  const useRight = border !== undefined && node.borderRight !== false;
  if (useTop) yoga.setBorder(Edge.Top, 1);
  if (useBottom) yoga.setBorder(Edge.Bottom, 1);
  if (useLeft) yoga.setBorder(Edge.Left, 1);
  if (useRight) yoga.setBorder(Edge.Right, 1);

  meta.set(yoga, {
    node,
    border,
    useTop,
    useBottom,
    useLeft,
    useRight,
    styleId: 0,
    hyperlinkId: 0,
  });

  const childList: YogaNode[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const childYoga = build(node.children[i]!, pools, measureText, meta, children);
    yoga.insertChild(childYoga, i);
    childList.push(childYoga);
  }
  children.set(yoga, childList);
  return yoga;
}

function applyBoxStyle(yoga: YogaNode, node: BoxNode): void {
  if (node.flexDirection === "row") yoga.setFlexDirection(FlexDirection.Row);
  else if (node.flexDirection === "row-reverse") yoga.setFlexDirection(FlexDirection.RowReverse);
  else if (node.flexDirection === "column-reverse")
    yoga.setFlexDirection(FlexDirection.ColumnReverse);
  else yoga.setFlexDirection(FlexDirection.Column);

  if (node.flexGrow !== undefined) yoga.setFlexGrow(node.flexGrow);
  if (node.flexShrink !== undefined) yoga.setFlexShrink(node.flexShrink);
  if (node.flexBasis !== undefined) yoga.setFlexBasis(node.flexBasis);
  if (node.flexWrap === "wrap") yoga.setFlexWrap(Wrap.Wrap);
  else if (node.flexWrap === "wrap-reverse") yoga.setFlexWrap(Wrap.WrapReverse);

  if (node.justifyContent) yoga.setJustifyContent(JUSTIFY_MAP[node.justifyContent]);
  if (node.alignItems) yoga.setAlignItems(ALIGN_MAP[node.alignItems]);
  if (node.alignSelf) yoga.setAlignSelf(ALIGN_MAP[node.alignSelf]);
  if (node.alignContent) {
    if (node.alignContent === "space-between") yoga.setAlignContent(Align.SpaceBetween);
    else if (node.alignContent === "space-around") yoga.setAlignContent(Align.SpaceAround);
    else yoga.setAlignContent(ALIGN_MAP[node.alignContent]);
  }

  if (node.width !== undefined) yoga.setWidth(node.width);
  if (node.height !== undefined) yoga.setHeight(node.height);
  if (node.minWidth !== undefined) yoga.setMinWidth(node.minWidth);
  if (node.minHeight !== undefined) yoga.setMinHeight(node.minHeight);
  if (node.maxWidth !== undefined) yoga.setMaxWidth(node.maxWidth);
  if (node.maxHeight !== undefined) yoga.setMaxHeight(node.maxHeight);

  // gap → both row + column gutters; specific overrides win.
  if (node.gap !== undefined) yoga.setGap(Gutter.All, node.gap);
  if (node.rowGap !== undefined) yoga.setGap(Gutter.Row, node.rowGap);
  if (node.columnGap !== undefined) yoga.setGap(Gutter.Column, node.columnGap);

  if (node.paddingTop !== undefined) yoga.setPadding(Edge.Top, node.paddingTop);
  if (node.paddingBottom !== undefined) yoga.setPadding(Edge.Bottom, node.paddingBottom);
  if (node.paddingLeft !== undefined) yoga.setPadding(Edge.Left, node.paddingLeft);
  if (node.paddingRight !== undefined) yoga.setPadding(Edge.Right, node.paddingRight);

  if (node.marginTop !== undefined) yoga.setMargin(Edge.Top, node.marginTop);
  if (node.marginBottom !== undefined) yoga.setMargin(Edge.Bottom, node.marginBottom);
  if (node.marginLeft !== undefined) yoga.setMargin(Edge.Left, node.marginLeft);
  if (node.marginRight !== undefined) yoga.setMargin(Edge.Right, node.marginRight);

  if (node.display === "none") yoga.setDisplay(Display.None);
}

export { Direction, MeasureMode };

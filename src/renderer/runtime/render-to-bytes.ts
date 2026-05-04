/** One-shot offline render of a React tree to ANSI bytes. */

import { type ReactNode, createElement } from "react";
import type { DiffPools } from "../diff/diff-frames.js";
import { ViewportContext } from "../ink-compat/viewport.js";
import { renderToScreen } from "../layout/layout.js";
import type { LayoutNode } from "../layout/node.js";
import { type HostRoot, hostToLayoutNode, reconciler } from "../reconciler/host-config.js";
import { CellWidth } from "../screen/cell.js";

const ESC = "\x1b";
const ST = `${ESC}\\`;

export function renderToBytes(element: ReactNode, width: number, pools: DiffPools): string {
  const layout = renderTreeToLayout(element, width);
  const screen = renderToScreen(layout, width, pools);
  if (screen.height === 0) return "";

  let out = "";
  let curStyle = pools.style.none;
  let curLink = 0;

  for (let y = 0; y < screen.height; y++) {
    if (y > 0) {
      out += pools.style.transition(curStyle, pools.style.none);
      curStyle = pools.style.none;
      if (curLink !== 0) {
        out += `${ESC}]8;;${ST}`;
        curLink = 0;
      }
      out += "\r\n";
    }
    for (let x = 0; x < screen.width; x++) {
      const cell = screen.cellAt(x, y);
      if (!cell) continue;
      if (cell.width === CellWidth.SpacerTail) continue;
      if (cell.styleId !== curStyle) {
        out += pools.style.transition(curStyle, cell.styleId);
        curStyle = cell.styleId;
      }
      if (cell.hyperlinkId !== curLink) {
        const uri = pools.hyperlink.get(cell.hyperlinkId) ?? "";
        out += `${ESC}]8;;${uri}${ST}`;
        curLink = cell.hyperlinkId;
      }
      out += pools.char.get(cell.charId);
    }
  }

  out += pools.style.transition(curStyle, pools.style.none);
  if (curLink !== 0) out += `${ESC}]8;;${ST}`;
  out += "\r\n";
  return out;
}

/** Render the element through a fresh reconciler container, walk the resulting
 *  host tree to a layout node, then unmount. Synchronous: react-reconciler
 *  with isPrimaryRenderer=false + LegacyMode commits eagerly. */
function renderTreeToLayout(element: ReactNode, width: number): LayoutNode {
  const root: HostRoot = {
    children: [],
    onCommit: () => {
      /* one-shot — caller reads root.children directly */
    },
  };
  const container = reconciler.createContainer(
    root,
    0, // LegacyMode — sync
    null,
    false,
    null,
    "rsx-static",
    () => {
      /* recoverable error */
    },
    null,
  );
  const wrapped = createElement(
    ViewportContext.Provider,
    { value: { columns: width, rows: 24 } },
    element,
  );
  reconciler.updateContainer(wrapped, container, null, () => {});

  const layoutChildren: LayoutNode[] = [];
  for (const c of root.children) {
    const child = hostToLayoutNode(c);
    if (child) layoutChildren.push(child);
  }
  const layout: LayoutNode =
    layoutChildren.length === 1 ? layoutChildren[0]! : { kind: "box", children: layoutChildren };

  reconciler.updateContainer(null, container, null, () => {});

  return layout;
}

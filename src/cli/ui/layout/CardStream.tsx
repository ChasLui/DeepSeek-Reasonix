import { Static } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { CardRenderer } from "../cards/CardRenderer.js";
import { ActiveCardContext } from "../primitives/Card.js";
import type { Card } from "../state/cards.js";
import { useAgentState } from "../state/provider.js";

/** Settled = no future event can mutate it; safe to commit via Ink's Static. */
function isSettled(card: Card): boolean {
  switch (card.kind) {
    case "streaming":
    case "tool":
    case "branch":
      return card.done;
    case "reasoning":
      return !card.streaming;
    case "plan":
      if (card.variant !== "active") return true;
      return card.steps.every((s) => s.status === "done" || s.status === "skipped");
    default:
      return true;
  }
}

export function CardStream(): React.ReactElement {
  const cards = useAgentState((s) => s.cards);
  let cutoff = cards.length;
  for (let i = 0; i < cards.length; i++) {
    if (!isSettled(cards[i] as Card)) {
      cutoff = i;
      break;
    }
  }
  const committed = cards.slice(0, cutoff);
  const live = cards.slice(cutoff);
  // Static items are emitted via bridge.emitStatic, which renders them in an
  // off-tree React reconciler — context from the live tree does NOT propagate.
  // The ActiveCardContext.Provider must therefore live inside the children
  // function so it travels with the rendered subtree.
  return (
    <>
      <Static items={committed}>
        {(card) => (
          <ActiveCardContext.Provider value={false} key={card.id}>
            <CardRenderer card={card} />
          </ActiveCardContext.Provider>
        )}
      </Static>
      {live.map((card) => (
        <CardRenderer key={card.id} card={card} />
      ))}
    </>
  );
}

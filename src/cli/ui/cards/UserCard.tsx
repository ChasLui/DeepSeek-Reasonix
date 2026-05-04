// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Markdown } from "../markdown.js";
import { Card } from "../primitives/Card.js";
import { CardHeader } from "../primitives/CardHeader.js";
import type { UserCard as UserCardData } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";
import { formatRelativeTime } from "./time.js";

export function UserCard({ card }: { card: UserCardData }): React.ReactElement {
  return (
    <Card tone={TONE.accent}>
      <CardHeader
        glyph="›"
        tone={TONE.accent}
        title="you"
        titleColor={FG.sub}
        meta={[formatRelativeTime(card.ts)]}
      />
      <Markdown text={card.text} />
    </Card>
  );
}

import { Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { t } from "../../i18n/index.js";
import { COLOR } from "./theme.js";

/**
 * Faint full-width horizontal rule. Width tracks the terminal columns
 * minus 2 cells so it lines up exactly under content rendered inside
 * a `paddingX={1}` parent — the standard chrome layout. Used by the
 * top chrome bar, the replay StatsPanel, and the bottom ctx footer.
 */
export function ChromeRule(): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const w = Math.max(20, cols - 2);
  return <Text dimColor>{"─".repeat(w)}</Text>;
}

/** Compact decimal-K/M token formatter — `1234 → "1.2K"`, `131000 → "131K"`, `1_000_000 → "1M"`. Base-1000 matches DeepSeek's "1M context" / "128K" wording and the web dashboard's display, so the CLI bottom bar and the web bar agree on ctx capacity. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (m >= 100 ? `${m.toFixed(0)}M` : `${m.toFixed(1)}M`).replace(".0M", "M");
  }
  const k = n / 1000;
  return (k >= 100 ? `${k.toFixed(0)}K` : `${k.toFixed(1)}K`).replace(".0K", "K");
}

/**
 * Filled / empty progress bar. `▰▱` glyphs have distinct shapes so the
 * boundary stays visible even when the terminal collapses to 8-color slots.
 */
export function Bar({
  ratio,
  color,
  cells = 14,
  dim,
}: {
  ratio: number;
  color: string;
  cells?: number;
  dim?: boolean;
}): React.ReactElement {
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return (
    <Text>
      <Text color={color} dimColor={dim}>
        {"▰".repeat(filled)}
      </Text>
      <Text dimColor>{"▱".repeat(cells - filled)}</Text>
    </Text>
  );
}

/**
 * `▣ ctx ▰▰▱▱…  14K/128K (11%)` — the canonical context-pressure cell.
 * Used by the persistent footer (chat) and StatsPanel (replay). Color
 * thresholds match the `/compact` warning policy in the loop:
 *   green <60% · amber 60-80% · red ≥80% (with `· /compact` hint).
 */
export function ContextCell({
  ratio,
  promptTokens,
  ctxMax,
  showBar,
}: {
  ratio: number;
  promptTokens: number;
  ctxMax: number;
  showBar?: boolean;
}): React.ReactElement {
  if (promptTokens === 0) {
    return (
      <Text>
        <Text color={COLOR.info} dimColor>
          {"▣ ctx "}
        </Text>
        <Text dimColor>{`\u2014 ${t("common.noTurns")}`}</Text>
      </Text>
    );
  }
  const color = ratio >= 0.8 ? COLOR.err : ratio >= 0.6 ? COLOR.warn : COLOR.ok;
  const pct = Math.round(ratio * 100);
  return (
    <Text>
      <Text color={COLOR.info}>{"▣ ctx  "}</Text>
      <Bar ratio={ratio} color={color} cells={showBar ? 14 : 10} />
      <Text> </Text>
      <Text color={color} bold>
        {formatTokens(promptTokens)}/{formatTokens(ctxMax)}
      </Text>
      <Text dimColor> ({pct}%)</Text>
      {ratio >= 0.8 ? (
        <Text color={COLOR.err} bold>
          {"  ·  /compact"}
        </Text>
      ) : null}
    </Text>
  );
}

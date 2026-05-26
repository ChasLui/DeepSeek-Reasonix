# E3 Report: cell-level inverse rendering and width slicing

Status: PARTIAL. No terminal screenshots were captured here, but code-level evidence confirms one v2 concern: `clipToCells` cannot be reused for selection slicing because it appends `...`/ellipsis on cuts. The current Codex session also cannot use `screencapture`, so the screenshot matrix still requires a real GUI terminal.

## Required screenshot matrix

Not completed in this Codex environment:

- 3 real ToolCard outputs with syntax highlight, CJK, and emoji.
- 4 terminals: iTerm2, Terminal.app, Alacritty, Windows Terminal.
- 3 render schemes: `chalk.inverse`, solid background, raw ANSI inverse.
- 12 screenshots total.

The current helper now prepares the exact ANSI fixtures to render in each GUI terminal:

```sh
OUT_DIR=/tmp/reasonix-tui-selection-manual bash docs/spike/tui-selection/collect-local-evidence.sh
cat /tmp/reasonix-tui-selection-manual/e3-render-samples/combined.ansi
```

Record screenshots back in `docs/spike/tui-selection/manual-terminal-checklist.md`.

## GUI automation capability

Current session probe:

```text
screencapture -x /tmp/reasonix-screen-test.png
-> could not create image from display

osascript -e 'tell application "System Events" to return UI elements enabled'
-> false
```

See `docs/spike/tui-selection/gui-automation-capability.md` for the full current-session report. `collect-local-evidence.sh` now writes a fresh `gui-capability.md` into each `OUT_DIR`.

When screenshots are captured, record them in `$OUT_DIR/manual-evidence.json` and run `node docs/spike/tui-selection/verify-manual-evidence.mjs $OUT_DIR/manual-evidence.json`. The verifier requires 12 screenshot files with PNG/JPEG magic bytes, coverage for all three schemes, and at least 4 terminal names that each include all three schemes.

## ANSI scheme byte evidence

Command:

```sh
FORCE_COLOR=1 npx tsx - <<'TS'
import chalk from "chalk";
const sample = "tool: console.log('中👩‍💻')";
const variants = [
  ["chalk.inverse", chalk.inverse(sample)],
  ["chalk.bgYellow.black", `${chalk.bgYellow.black(sample)}\x1b[49m`],
  ["raw inverse", `\x1b[7m${sample}\x1b[27m`],
] as const;
for (const [name, value] of variants) {
  console.log(`${name}: ${JSON.stringify(value)}`);
}
TS
```

Observed with `FORCE_COLOR=1`:

```text
chalk.inverse: "\u001b[7mtool: console.log('中👩‍💻')\u001b[27m"
chalk.bgYellow.black: "\u001b[43m\u001b[30mtool: console.log('中👩‍💻')\u001b[39m\u001b[49m\u001b[49m"
raw inverse: "\u001b[7mtool: console.log('中👩‍💻')\u001b[27m"
```

Interpretation:

- `chalk.inverse` is effectively raw SGR `7m` / `27m` under color-enabled output.
- Solid background emits foreground/background resets and the manual `49m` appended here produced a duplicate background reset.
- Screenshot validation is still required before choosing a visual scheme.

## `clipToCells` evidence

Source:

```text
24: /** Clip to `maxCells` visual cells; appends `…` if cut. Grapheme-safe. */
25: export function clipToCells(s: string, maxCells: number): string {
...
37: return `${out}…`;
```

Command:

```sh
npx tsx -e 'import { clipToCells, stringWidth, graphemes, graphemeWidth } from "./src/frame/width.ts"; const samples=["abcdef","中abcdef","a👩‍💻b","中"]; for (const s of samples) { for (let n=1;n<=4;n++) console.log(JSON.stringify(s), n, JSON.stringify(clipToCells(s,n)), stringWidth(clipToCells(s,n))); console.log("graphemes", graphemes(s).map(g => `${g}:${graphemeWidth(g)}`).join("|")); }'
```

Observed:

```text
"abcdef" 1 "…" 1
"abcdef" 2 "a…" 2
"abcdef" 3 "ab…" 3
"abcdef" 4 "abc…" 4
graphemes a:1|b:1|c:1|d:1|e:1|f:1
"中abcdef" 1 "…" 1
"中abcdef" 2 "…" 1
"中abcdef" 3 "中…" 3
"中abcdef" 4 "中a…" 4
graphemes 中:2|a:1|b:1|c:1|d:1|e:1|f:1
"a👩‍💻b" 1 "…" 1
"a👩‍💻b" 2 "a…" 2
"a👩‍💻b" 3 "a…" 2
"a👩‍💻b" 4 "a👩‍💻b" 4
graphemes a:1|👩‍💻:2|b:1
"中" 1 "…" 1
"中" 2 "中" 2
"中" 3 "中" 2
"中" 4 "中" 2
```

## Finding

`clipToCells` is correct for truncating display text, but it is wrong for `[before, selected, after]` selection slicing because it injects an ellipsis that was never selected. v3 should add a dedicated `sliceCells` helper if Slice 2 survives.

## Decision impact

- Keep v2's correction: do not reuse `clipToCells` for cell-level selection slicing.
- Do not choose inverse vs solid background until the required screenshot matrix exists.

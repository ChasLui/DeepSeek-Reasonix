# Manual Terminal Checklist

Use this checklist to complete the parts of the spike that cannot be proven from a headless Codex session.

## Setup

Run from the repo root on `spike/tui-selection-research`:

```sh
OUT_DIR=/tmp/reasonix-tui-selection-manual bash docs/spike/tui-selection/collect-local-evidence.sh
```

Keep the generated `OUT_DIR` path in the report row you fill in.

The helper also writes `gui-capability.md`. If that report says screenshot
capture or UI scripting is unavailable, the GUI rows below must be filled by a
human in a real terminal. The current Codex session's static capability report
is `docs/spike/tui-selection/gui-automation-capability.md`.

The helper also copies `manual-evidence.template.json` to
`$OUT_DIR/manual-evidence.json`. Fill that JSON alongside this checklist, put
screenshots/evidence files under `$OUT_DIR`, then run:

```sh
node docs/spike/tui-selection/verify-manual-evidence.mjs /tmp/reasonix-tui-selection-manual/manual-evidence.json
```

Final manual evidence is not complete until the verifier exits 0.

Regenerate the completion audit after the verifier passes:

```sh
node docs/spike/tui-selection/generate-completion-audit.mjs /tmp/reasonix-tui-selection-manual/manual-evidence.json > /tmp/reasonix-tui-selection-manual/completion-audit.md
```

## E0 Reproduction

Run the protocol helper first to capture a normalized row:

```sh
node docs/spike/tui-selection/e0-selection-probe.mjs
```

Then run the full Reasonix command below if the protocol helper reproduces the selection behavior and you need app-level confirmation.

| Terminal | OS | Command | Default drag-select result | `/mouse on` drag result | `/mouse off` after `/mouse on` result | Shift+Drag while `/mouse on` result | Clipboard result | Evidence |
|---|---|---|---|---|---|---|---|---|
|  |  | `npm run dev -- chat --no-session --no-dashboard --new --no-config` |  |  |  |  |  |  |

Use precise observations:

- `no highlight`
- `highlight but clipboard empty`
- `highlight and clipboard contains selected text`
- `terminal bypass works only with Shift`
- `not reproducible`

The verifier requires one E0 row to prove the current contract in the same terminal:
default drag-select works (`highlight and clipboard contains selected text`),
`/mouse on` behavior is recorded, `/mouse off` restores
`highlight and clipboard contains selected text`, and Shift+Drag while tracking
is on is recorded.

## E2 Path E Matrix

Only run this if Path E is still under consideration after the parser finding in `E2-report.md`.

Temporary source change for this experiment only:

```diff
-const ENABLE = "\u001b[?1000h\u001b[?1006h";
+const ENABLE = "\u001b[?1000h";
```

Revert the temporary source change after collecting data.

| Terminal | OS | Context | Width | Wheel terminal sends? | Repo receives? | Composer polluted? | Drag-select restored? | Evidence |
|---|---|---|---:|---|---|---|---|---|
| iTerm2 | macOS | local | 80 |  |  |  |  |  |
| iTerm2 | macOS | local | 250 |  |  |  |  |  |
| Terminal.app | macOS | local | 80 |  |  |  |  |  |
| Alacritty | macOS/Linux | local | 80 |  |  |  |  |  |
| Windows Terminal | Windows | local | 80 |  |  |  |  |  |
|  |  | ssh | 80 |  |  |  |  |  |
|  |  | tmux | 80 |  |  |  |  |  |

## E3 Rendering Screenshots

The helper writes reusable ANSI fixtures under:

```sh
OUT_DIR=/tmp/reasonix-tui-selection-manual bash docs/spike/tui-selection/collect-local-evidence.sh
cat /tmp/reasonix-tui-selection-manual/e3-render-samples/combined.ansi
```

For each terminal, display the same fixture and capture screenshots for:

- `chalk.inverse`
- solid background
- raw ANSI inverse

Screenshot files must be real PNG or JPEG files. The JSON verifier rejects
placeholder text files even if they are non-empty.

| Terminal | OS | Sample | Scheme | Readability 1-5 | Color reset correct? | EOL spill? | Screenshot |
|---|---|---|---|---:|---|---|---|
|  |  | ToolCard syntax + CJK + emoji | chalk.inverse |  |  |  |  |
|  |  | ToolCard syntax + CJK + emoji | solid bg |  |  |  |  |
|  |  | ToolCard syntax + CJK + emoji | raw inverse |  |  |  |  |

## E4 Binding Matrix

Run the key probe in each terminal/context and paste its table into the Evidence column:

```sh
node docs/spike/tui-selection/e4-key-probe.mjs
```

If `Ctrl+S` freezes output, press `Ctrl+Q` to resume; the timeout/no-bytes result is the expected evidence that the terminal intercepted XOFF.

| Terminal | Context | `stty -a` IXON state | Ctrl+S reaches app? | Alt+M reaches app? | Ctrl+T reaches app? | Recommended binding |
|---|---|---|---|---|---|---|
| iTerm2 | local |  |  |  |  |  |
| Terminal.app | local |  |  |  |  |  |  |
| Alacritty | local |  |  |  |  |  |
| Windows Terminal | local |  |  |  |  |  |
| VS Code terminal | local |  |  |  |  |  |
|  | ssh |  |  |  |  |  |
|  | tmux |  |  |  |  |  |

## FR-104 Row Offset Matrix

Run the row-offset probe in each terminal/layout and click the `h` in `hello world`.

```sh
node docs/spike/tui-selection/fr104-row-offset-probe.mjs
PREFIX_ROWS=1 node docs/spike/tui-selection/fr104-row-offset-probe.mjs
```

The second command simulates CopyMode being nested under one parent row. Paste the generated table into the Evidence column.

| Terminal | Context | Prefix rows | Probe result | Evidence |
|---|---|---:|---|---|
| iTerm2 | local | 0 |  |  |
| iTerm2 | local | 1 |  |  |
| Terminal.app | local | 0 |  |  |
| Terminal.app | local | 1 |  |  |
| VS Code terminal | local | 0 |  |  |
|  | ssh | 0 |  |  |
|  | tmux | 0 |  |  |

## E5 License

Record owner/legal response:

| Contact | Date | Response | Allows vendoring? | Conditions | Evidence |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Machine-Checkable Completion

The JSON verifier currently checks:

- `OUT_DIR` helper artifacts: `gui-capability.md`, `local-probes.log`, `stdin-parser-probe.txt`, `clip-to-cells-probe.txt`, and `e3-render-samples/combined.ansi`.
- E0 has at least one same-row default native / `/mouse on` / `/mouse off`
  contrast proving default drag-select works, `/mouse off` recovery after
  tracking was enabled, Shift+Drag behavior while tracking is on, and a
  non-empty evidence file.
- E3 has 12 screenshot rows, includes `chalk.inverse`, `solid bg`, and `raw inverse`, has at least 4 terminal names with all three schemes, and every screenshot has PNG/JPEG magic bytes.
- E4 has at least 30 rows, covers `local`, `ssh`, and `tmux`, includes at least 5 distinct terminal names, and includes both `ixon` enabled and disabled rows.
- FR-104 has at least 7 rows, covers `local`, `ssh`, and `tmux`, includes `PREFIX_ROWS=0` and `PREFIX_ROWS=1`, and each probe result is `PASS`.
- E2 is required only when `pathEConsidered: true`; then it requires at least 30 rows, covers `local`, `ssh`, and `tmux`, includes at least 5 distinct terminal names, and contains both narrow (`<=80`) and wide (`>223`) column widths.

# TUI Selection Spike Summary

Branch: `spike/tui-selection-research`

Status: INCOMPLETE. Reports exist for E0-E5 plus the v2 user-research brief and GUI automation capability check, but the spike is not complete because the required GUI-terminal manual matrices and screenshots are still missing.

Implementation status: PARTIAL LANDED on this branch. Startup now keeps SGR 1000/1006 mouse tracking off by default so terminal-native drag-select owns plain drag. Runtime mouse tracking can still be toggled with `/mouse [on|off|toggle]` and `Alt+M`; the status row shows `mouse:on` / `mouse:off (drag to select)`; stale mouse reports are ignored while tracking is inactive; startup/exit cleanup is unconditional; `/mouse off` force-writes the off sequence to clear stale terminal state. CopyMode now has mouse drag -> character-span yank, double-click word/path yank, triple-click line yank, `sliceCells`-backed inverse rendering, Ink-measured row-offset mapping, and tempfile fallback status. The performance gate is covered by `tests/copy-mode-perf.test.tsx`; the screenshot gate and manual terminal evidence matrix remain incomplete.

## Strong findings

1. Current startup does not emit `?1000h` / `?1006h` unless `mouseTracking: true` or `/mouse on` is used; cleanup emits `?1006l` and `?1000l`.
2. No `1002`, `1003`, or `1004` enable sequence appeared in the captured startup path.
3. Path E cannot be implemented by simply removing `1006`. Current `stdin-reader` parses SGR reports, but X10-shaped bytes become printable `input` events such as `` `*% ``.
4. `clipToCells` is not suitable for selection slicing because it appends an ellipsis on cuts.
5. Local `stty` has `ixon` enabled and `stop = ^S`, so `Ctrl+S` is unsafe as a default binding without stronger terminal matrix evidence.
6. The sourcemap reference repo has no explicit license in the files inspected; the current branch does not vendor source code, and owner/legal approval is only required before future source copying.
7. Current docs/i18n no longer claim `1007`-only or native drag-select unaffected behavior.

## Implemented branch changes

- `src/cli/ui/mouse-mode.ts`: active-state snapshot, subscriber, set/toggle helpers, and force-off cleanup for stale terminal state.
- `src/cli/ui/stdin-reader.ts`: parser reset API and inactive-mode mouse event guard.
- `src/cli/ui/slash/handlers/basic.ts`: `/mouse [on|off|toggle]`.
- `src/cli/ui/App.tsx`: `Alt+M` global toggle.
- `src/cli/ui/layout/StatusRow.tsx`: visible mouse mode segment.
- `src/cli/commands/chat.tsx` and `src/cli/commands/code.tsx`: native drag-select default, explicit `mouseTracking: true` opt-in, and unconditional mouse cleanup hooks across both TUI entry points.
- `src/config.ts` and `src/cli/ui/App.tsx`: one-time mouse/clipboard onboarding tip persisted via `~/.local/state/reasonix/seen-mouse-hint.flag`.
- `src/frame/width.ts`: `sliceCells` helper for grapheme-safe selection slicing without ellipsis.
- `src/cli/ui/copy-mode/cell-selection.ts`: pure cell-range normalization and yank extraction.
- `src/cli/ui/copy-mode/CopyMode.tsx`: basic mouse click/drag/release selection, 2s lost-release fallback, inverse character-span rendering, and mouse-yank clipboard status.
- `tests/copy-mode-perf.test.tsx`: 1000-line viewport render guard and mouseDrag P95 regression coverage.
- `src/i18n/*`, `docs/CLI-REFERENCE.md`, `docs/cli-reference.html`, `docs/cli-ref-i18n.js`: removed stale `1007 only` / "native drag-select unaffected" claims.

## Still required before v3

- E0: manual default native drag-select vs `/mouse on` vs `/mouse off` vs Shift+Drag reproduction in the target terminal.
- E2: 5 terminals x local/ssh/tmux x narrow/wide matrix if Path E is still being considered after the parser finding.
- E3: 12 screenshots for inverse/solid-bg/raw-inverse rendering.
- E4: 5 terminals x local/ssh/tmux x IXON state matrix for candidate bindings.
- E5: no current blocker because this branch uses an independent implementation; owner response or legal decision is only required if sourcemap code is copied in the future.
- Slice 2 hardening: GUI validation of measured row offsets across terminal layouts and screenshot gate.
- User research: real issue/Discord/telemetry data, if available. GitHub issues are disabled through `gh` in this repo.

## Current v3 direction

Based on evidence collected so far, the safest v3 default is not Path E. Prefer:

- native drag-select by default plus explicit runtime mouse toggle and accurate hints/docs, or
- CopyMode-local selection improvements that do not depend on terminal-native drag behavior, or
- X10 parser work as an explicit prerequisite before any protocol downgrade.

Do not draft v3 as complete until the manual matrices above are filled.

## Reproduction helper

Use `collect-local-evidence.sh`, `e0-selection-probe.mjs`, `e4-key-probe.mjs`, `fr104-row-offset-probe.mjs`, `manual-evidence.template.json`, `verify-manual-evidence.mjs`, `generate-completion-audit.mjs`, and `manual-terminal-checklist.md` to finish the evidence bundle in a GUI terminal. The helper writes local artifacts under `/tmp/reasonix-tui-selection-<timestamp>/` by default; set `OUT_DIR=...` if you need a stable artifact path.

The current Codex session cannot automate the GUI pieces: see `gui-automation-capability.md`. Run the helper from a real Terminal.app or Ghostty window to finish E0/E3/E4/FR-104.

When the manual rows and screenshots are filled, run:

```sh
node docs/spike/tui-selection/verify-manual-evidence.mjs /tmp/reasonix-tui-selection-manual/manual-evidence.json
```

The verifier is intentionally stricter than the Markdown checklist: it requires helper artifacts, an E0 same-row default native / `/mouse on` / `/mouse off` contrast, E0/E3/E4/FR-104 evidence files to exist, E3 screenshot files to have PNG/JPEG magic bytes across at least 4 complete terminal/scheme sets, and the E2/E4/FR-104 matrices to cover their required contexts instead of repeating one local-only row.

Script regressions are covered by `tests/tui-selection-spike-scripts.test.ts`; run `npx vitest run tests/tui-selection-spike-scripts.test.ts` after editing this directory.

The helper also writes `$OUT_DIR/completion-audit.md`, including plan evidence, implementation evidence, spike artifacts, and the manual evidence gate. Regenerate it after filling manual evidence:

```sh
node docs/spike/tui-selection/generate-completion-audit.mjs /tmp/reasonix-tui-selection-manual/manual-evidence.json > /tmp/reasonix-tui-selection-manual/completion-audit.md
```

# E0 Report: reproduce user selection complaint

Status: PARTIAL, with the original startup finding superseded by the resumed implementation. The non-interactive Codex environment proved that the prior TUI startup enabled mouse tracking; current source now keeps mouse tracking off by default and requires `mouseTracking: true`, `/mouse on`, or `Alt+M` to opt in. This environment still cannot complete the human drag/highlight clipboard checks required by the spike matrix; see `gui-automation-capability.md`.

## Environment

- Branch: `spike/tui-selection-research`
- HEAD: `cbf746b92c6c1ee1baca9faa6094d26cf1ad17ef`
- OS: `Darwin mbp14 25.5.0 ... RELEASE_ARM64_T6000 arm64`
- Repo CLI version from source: `npm run dev -- --version` -> `0.47.2`
- Installed shim: `reasonix --version` -> `0.47.2`
- Non-interactive shell env: `TERM=dumb`; TTY probes used `script(1)` where needed.

## User report source

No GitHub issue body is available through `gh`: `gh issue view 1337` and `gh issue view 514` both returned `the 'ChasLui/DeepSeek-Reasonix' repository has disabled issues`.

Available repo-local evidence:

- `docs/plans/2026-05-26-tui-selection-research-spike.md` records the user-facing report as `"TUI 无法选中"（鼠标拖选无效）`.
- Commit `1b853df` says multiple users could not copy text and traces the root cause to DECSET `1000 + 1006` mouse tracking.
- Commit `dd26f30` re-enabled `\x1b[?1000h\x1b[?1006h` and explicitly records the tradeoff: native drag-select stops working with mouse tracking on; Shift+drag still selects in many terminals.
- Commit `2ace8fd` added `--no-mouse` and says `Closes #1337`, but the issue body is not accessible in this repo.

## Reproduction evidence collected

Command:

```sh
rm -f /tmp/mm-startup.log
script -q /tmp/mm-startup.log npm run dev -- chat --no-session --no-dashboard --new --no-config
# press Esc in the session picker to exit
perl -0777 -ne 'while(/\e\[\?([0-9;]+)([hl])/g){ print "?${1}${2}\n" }' /tmp/mm-startup.log
```

Observed mouse/control sequences before the resumed default-off fix:

```text
?1000h
?1006h
?2026h
?25l
?2026l
?1006l
?1000l
?2026h
?2026l
?25h
?25h
?25h
```

Interpretation:

- Prior source startup enabled DECSET `1000` and SGR extended coordinates `1006`.
- Current source starts with mouse tracking off unless explicitly opted in.
- Current cleanup disables `1006` then `1000`, including stale terminal state where this process did not set `active=true`.

## Required manual checks not completed here

The spike requires same-terminal manual checks:

- Default mode: drag-select behavior, whether highlight appears, whether `Ctrl+C` copies text.
- `/mouse on`: record whether plain drag is captured or still terminal-native.
- `/mouse off` after `/mouse on`: confirm native drag-select behavior returns.
- `/mouse on` + Shift+Drag: confirm terminal bypass behavior.

Use the protocol helper below to produce a normalized matrix row before doing app-level confirmation:

```sh
node docs/spike/tui-selection/e0-selection-probe.mjs
```

These require a human-operated GUI terminal. They are not proven by this report.

## Decision impact

Proceed to E1-E5 for data collection, but do not treat E0 as fully passed until the human drag-select checks are recorded with terminal name, OS, and visible behavior.

Machine-checkable follow-up: add the E0 evidence file path to `$OUT_DIR/manual-evidence.json` and run `node docs/spike/tui-selection/verify-manual-evidence.mjs $OUT_DIR/manual-evidence.json`. The verifier requires one row to show default native drag-select works, `/mouse on` behavior is recorded, `/mouse off` restores selection after opt-in tracking, and Shift+Drag behavior is recorded in the same terminal.

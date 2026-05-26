# E4 Report: Ctrl+S / IXON flow-control compatibility

Status: PARTIAL. Local TTY configuration strongly argues against `Ctrl+S` as the default binding, but the full 5-terminal x 3-context matrix has not been run. The current Codex session lacks GUI terminal automation capability; see `gui-automation-capability.md`.

## Local TTY evidence

Command:

```sh
script -q /tmp/stty.log stty -a
```

Observed:

```text
iflags: -istrip icrnl -inlcr -igncr ixon -ixoff ixany imaxbel -iutf8
cchars: ... start = ^Q; ... stop = ^S; ...
```

Interpretation:

- `ixon` is enabled in the local pseudo-terminal.
- `Ctrl+S` is configured as the terminal stop/XOFF character.
- A TUI-level `Ctrl+S` binding is therefore not a safe default without first disabling IXON or proving each target terminal passes it through.

## Attempted key probe

I attempted a raw-mode Node key probe under `script(1)` and direct PTY sessions. The probe timed out when sending `Ctrl+S`; this is consistent with IXON interception, but the Codex PTY writer did not reliably deliver other synthetic raw key bytes either, so this is not strong enough to count as a completed matrix row.

## Required matrix not completed

Use the interactive helper below in each GUI terminal/context to collect the raw bytes and paste its table into `manual-terminal-checklist.md`:

```sh
node docs/spike/tui-selection/e4-key-probe.mjs
```

| Terminal | Context | IXON state | Ctrl+S reaches app? | Alt+M reaches app? | Ctrl+T reaches app? |
|---|---|---|---|---|---|
| iTerm2 | local | default | not tested | not tested | not tested |
| Terminal.app | local | default | not tested | not tested | not tested |
| Alacritty | local | default | not tested | not tested | not tested |
| Windows Terminal | local | default | not tested | not tested | not tested |
| VS Code terminal | local | default | not tested | not tested | not tested |
| Any | ssh | default | not tested | not tested | not tested |
| Any | tmux | default | not tested | not tested | not tested |

## Decision impact

Do not hard-code `Ctrl+S` as the default toggle binding in v3 based only on v1/v2 assumptions. Current local evidence favors a non-flow-control binding such as `Alt+M` or `Ctrl+T`, pending a real terminal matrix.

Machine-checkable follow-up: add the E4 probe output files to `$OUT_DIR/manual-evidence.json` and run `node docs/spike/tui-selection/verify-manual-evidence.mjs $OUT_DIR/manual-evidence.json`. The verifier requires at least 15 E4 rows.

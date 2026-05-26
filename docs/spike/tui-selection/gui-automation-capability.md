# GUI Automation Capability Report

Status: GUI AUTOMATION NOT AVAILABLE IN CURRENT CODEX SESSION.

This report records why the remaining GUI/manual matrix cannot be completed
from the current non-interactive Codex process. It does not replace E0/E3/E4 or
FR-104 evidence; it explains why those rows still require a real terminal
session.

## Current environment

```text
ProductName: macOS
ProductVersion: 26.5
BuildVersion: 25F71
TERM=dumb
TTY=not a tty
```

Terminal apps found:

```text
/System/Applications/Utilities/Terminal.app
/Applications/Ghostty.app
```

Ghostty version:

```text
Ghostty 1.3.1
```

## Probes attempted

Screenshot probe:

```sh
rm -f /tmp/reasonix-screen-test.png
screencapture -x /tmp/reasonix-screen-test.png
file /tmp/reasonix-screen-test.png
test -s /tmp/reasonix-screen-test.png
```

Observed:

```text
could not create image from display
```

Accessibility probe:

```sh
osascript -e 'tell application "System Events" to return UI elements enabled'
```

Observed:

```text
false
```

Terminal.app automation probe:

```sh
osascript -e 'tell application "Terminal" to do script "printf reasonix-terminal-probe; sleep 3"'
```

Observed: the command did not complete in the Codex session and was killed after
it stayed stuck on the automation path. This is consistent with the current
session lacking the GUI automation permissions needed to drive Terminal.app.

Computer Use terminal-app probe:

```text
list_apps showed Ghostty frontmost/running and Terminal.app launchable.
get_app_state(app="Ghostty") -> Computer Use is not allowed to use com.mitchellh.ghostty.
get_app_state(app="Terminal") -> Computer Use is not allowed to use com.apple.Terminal.
```

Observed: the available desktop automation connector is explicitly blocked from
controlling both terminal apps needed for this matrix. It can confirm that a GUI
terminal exists, but it cannot perform drag-select, Shift+Drag, key delivery, or
row-offset click probes inside those terminal windows.

## Impact

- E3 terminal screenshots cannot be captured from this Codex process.
- FR-104 row-offset clicks cannot be generated against a GUI terminal from this
  process.
- E0 native drag-select and Shift+Drag behavior cannot be verified without a
  human-operated GUI terminal.
- E4 key delivery can still be probed in a real terminal with
  `e4-key-probe.mjs`, but this Codex process cannot complete the terminal matrix.

## Follow-up path

Run the existing helper from a real Terminal.app or Ghostty window:

```sh
OUT_DIR=/tmp/reasonix-tui-selection-manual bash docs/spike/tui-selection/collect-local-evidence.sh
```

Then complete:

- `docs/spike/tui-selection/manual-terminal-checklist.md`
- `$OUT_DIR/manual-evidence.json`
- E3 screenshots from
  `/tmp/reasonix-tui-selection-manual/e3-render-samples/combined.ansi`
- E0/E4/FR-104 rows using the interactive probe scripts in the same directory
- `node docs/spike/tui-selection/verify-manual-evidence.mjs $OUT_DIR/manual-evidence.json`
- `node docs/spike/tui-selection/generate-completion-audit.mjs $OUT_DIR/manual-evidence.json > $OUT_DIR/completion-audit.md`

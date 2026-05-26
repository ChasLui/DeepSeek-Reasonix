# E2 Report: Path E X10-alone feasibility

Status: FAIL for current code shape. Full 5-terminal manual matrix is still missing, but the parser-level evidence is enough to reject "just remove 1006" as a safe implementation.

## Question

Path E proposes changing `ENABLE` from:

```ts
"\u001b[?1000h\u001b[?1006h"
```

to:

```ts
"\u001b[?1000h"
```

The hypothesis was: wheel might still work while native drag-select recovers.

## Protocol evidence

Official xterm control-sequence documentation says:

- DECSET `1000` enables normal mouse tracking.
- DECSET `1006` enables SGR mouse mode.
- Without SGR `1006`, normal mouse responses use the older X10-style `CSI M Cb Cx Cy` byte encoding, with original coordinate limits around 223 cells.

Reference: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking

## Parser evidence

Current `stdin-reader` only recognizes SGR mouse reports:

```text
118: const SGR_MOUSE_ESCAPELESS_RE = /^\[<\d+;\d+;\d+[Mm]/;
121: function decodeSgrMouseBody(body: string): KeyEvent | null {
129: if (tail === "m") return { input: "", mouseRelease: true, ... };
130: if (btn === 64) return { input: "", mouseScrollUp: true, ... };
131: if (btn === 65) return { input: "", mouseScrollDown: true, ... };
132: if (btn === 0) return { input: "", mouseClick: true, ... };
133: if (btn === 32) return { input: "", mouseDrag: true, ... };
570: if (seq.length > 1 && seq.charCodeAt(0) === 60 /* '<' */) { ... }
```

Command:

```sh
OUT_DIR=/tmp/reasonix-tui-selection-parser SKIP_INTERACTIVE=1 \
  bash docs/spike/tui-selection/collect-local-evidence.sh
cat /tmp/reasonix-tui-selection-parser/stdin-parser-probe.txt
```

The probe temporarily marks mouse mode active while suppressing the actual
terminal escape writes, so the inactive-mode guard does not hide SGR parser
behavior.

Observed:

```text
SGR click [{"input":"","mouseClick":true,"mouseRow":5,"mouseCol":10}]
SGR wheel-up [{"input":"","mouseScrollUp":true,"mouseRow":5,"mouseCol":10}]
SGR release [{"input":"","mouseRelease":true,"mouseRow":5,"mouseCol":10}]
X10-ish click [{"input":" *%"}]
X10-ish wheel-up [{"input":"`*%"}]
```

## Finding

Current parser does not merely drop X10 mouse bytes. It consumes `ESC [ M` as an unknown CSI and then emits the coordinate bytes as printable input. That means Path E without an X10 parser can corrupt the composer with characters such as `` `*% `` during mouse activity.

## Manual matrix status

Not completed in this Codex environment:

| Terminal | OS | Context | Width | Wheel terminal sends? | Repo receives? | Drag-select restored? |
|---|---|---|---:|---|---|---|
| iTerm2 | macOS | local | 80 | not tested | parser rejects X10 | not tested |
| iTerm2 | macOS | local | 250 | not tested | parser rejects X10; X10 coordinate limit risk | not tested |
| Terminal.app | macOS | local | 80 | not tested | parser rejects X10 | not tested |
| Alacritty | macOS/Linux | local | 80 | not tested | parser rejects X10 | not tested |
| Windows Terminal | Windows | local | 80 | not tested | parser rejects X10 | not tested |
| Any | ssh/tmux | any | any | not tested | parser rejects X10 | not tested |

## Decision impact

Do not ship Path E as "remove `1006` only". A viable X10-alone path must first add an X10 parser and tests, then rerun the 5-terminal matrix. Given this evidence, v3 should either:

- keep SGR `1006` and implement runtime toggle/hints, or
- add an explicit X10 parser task before considering Path E.

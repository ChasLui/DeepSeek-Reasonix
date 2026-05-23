# Terminal key model

Reasonix treats terminal keyboard input as bytes first, not as OS key events. A TUI
running behind a PTY only sees what the terminal emulator chooses to send.

## Default macOS reality

On an unconfigured macOS terminal, `Cmd` shortcuts usually belong to the terminal
emulator or the OS before the PTY sees anything. `Cmd+C` copies, `Cmd+V` pastes,
`Cmd+T` opens a tab, and Reasonix should not promise that default `Cmd` chords work
as app shortcuts.

This is not the same as saying `Cmd` is impossible. Users can deliberately make
bytes reach the PTY through terminal-specific mappings or remappers:

- iTerm2 key mappings can send escape sequences, hex bytes, or text for a chosen
  key combination.
- iTerm2 can remap modifier keys within iTerm2, for example making physical
  `Cmd` act like `Option`.
- Kitty keyboard protocol can report `Cmd` as the `super` modifier when the
  protocol is enabled and the terminal key binding does not intercept the chord.
- Karabiner, Hammerspoon, or system-level remaps can change which key sequence
  enters the terminal.

The product-facing rule is therefore conservative: Reasonix app shortcuts are
documented as `Ctrl`, not `Cmd`. Clipboard shortcuts stay terminal-native:
`Cmd+C/V` on macOS, `Ctrl+Shift+C/V` or terminal-specific variants elsewhere.

## Modifier fields

`KeyEvent` exposes distinct fields:

| Field | Meaning in Reasonix |
| --- | --- |
| `ctrl` | Control modifier or legacy control byte such as `0x03` for `Ctrl+C`. |
| `shift` | Shift modifier when the terminal reports it. |
| `alt` | Option/Alt semantic modifier, including ESC-prefix input. |
| `super` | Command/Windows/Super when an extended protocol reports it. |
| `hyper` | Hyper when an extended protocol reports it; no app binding yet. |
| `meta` | True Meta modifier from extended protocols; no app binding yet. |

Older code used `meta` for ESC-prefix Option/Alt. New input parsing normalizes that
path to `alt`, and fallback Ink events map Ink's `key.meta` into `alt`. Protocol
`meta` is kept separate and is not bound to prompt-editing actions.

## Extended protocol decoding

Reasonix passively decodes `modifyOtherKeys` and Kitty-style CSI-u sequences. The
modifier value is interpreted as `1 + bitfield`, using the Kitty keyboard protocol
layout:

| Bit | Modifier |
| --- | --- |
| `1` | `shift` |
| `2` | `alt` |
| `4` | `ctrl` |
| `8` | `super` |
| `16` | `hyper` |
| `32` | `meta` |
| `64` | `caps_lock` |
| `128` | `num_lock` |

Lock bits are ignored for app behavior. Unknown future bits are dropped rather than
treated as plain printable input.

Examples now accepted by `StdinReader`:

| Sequence | Event |
| --- | --- |
| `CSI 99;9u` | `{ input: "c", super: true }` |
| `CSI 99;5u` | `{ input: "c", ctrl: true }` |
| `CSI 99;10u` | `{ input: "c", shift: true, super: true }` |
| `CSI 27;3;13~` | `{ input: "", return: true, alt: true }` |

Reasonix does not actively enable Kitty keyboard protocol by default. Active
push/pop support would change terminal protocol state and needs separate lifecycle
handling for quit, signals, suspend/resume, tmux, SSH, and crash recovery.

## Static capability detection

`detectKeyCapabilities()` is intentionally env-only. It reads `process.platform`,
`TERM_PROGRAM`, `TERM`, `WT_SESSION`, `TMUX`, and `STY`; it never probes stdin or
enters raw mode. It is used for conservative UX hints, not as proof that a chord
will work.

Current static categories:

| Environment | Option/Alt | Super/Cmd | Extended keys |
| --- | --- | --- | --- |
| Apple Terminal | unknown from env | no by default | no |
| iTerm2 | unknown from env | maybe via explicit mappings/remap | maybe |
| Warp | yes | no by default | maybe |
| kitty / WezTerm / Ghostty / Alacritty | yes | maybe with protocol/config | yes |
| Windows Terminal | n/a | no by default | maybe |
| legacy conhost | n/a | no | no |
| tmux / screen | depends on outer terminal and config | depends on outer terminal and config | maybe at best |

## Current Reasonix behavior

- `/keys` and the first macOS startup hint say Reasonix app shortcuts use `Ctrl`,
  not `Cmd`.
- ESC-prefix and modifyOtherKeys Alt input is represented as `alt`.
- `Alt+Enter`, `Alt+B`, `Alt+F`, and `Alt+Backspace` still work in the multiline
  prompt path.
- `super`, `hyper`, and true protocol `meta` are parsed so the bytes are not lost,
  but they are not bound to app actions yet.
- Components that still call Ink `useInput` directly remain limited to Ink's
  `ctrl`/`meta`/`shift` surface. Those paths are intentionally outside this phase.

## References

- Kitty keyboard protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- WezTerm key modifiers: https://wezterm.org/config/keys.html
- iTerm2 key mappings and modifier remapping: https://iterm2.com/help/

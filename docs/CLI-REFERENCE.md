# Reasonix CLI Reference

Every shell subcommand, every TUI slash command, every keybinding. The in-app `/help` and `/keys` panels are the live source of truth — this page is the printable companion.

---

## Shell subcommands

Run `reasonix --help` (or any subcommand with `--help`) for the full flag list. Headline subcommands:

| Subcommand | What it does |
|---|---|
| `reasonix code [dir]` | Code-mode TUI — file edits, plan mode, edit-gate, project-scoped sessions |
| `reasonix chat` | Chat-only TUI — no filesystem access, no code mode |
| `reasonix run <task>` | Headless run — read prompt, execute, exit (CI-friendly) |
| `reasonix setup` | Interactive first-run config (API key, language, theme) |
| `reasonix sessions [name]` | List or open a saved session |
| `reasonix prune-sessions` | Drop sessions older than `--days N` |
| `reasonix replay <transcript>` | Re-render a JSONL transcript without calling the model |
| `reasonix diff <a> <b>` | Compare two transcripts (cost / cache / tokens) |
| `reasonix events <name>` | Tail the event log for a session |
| `reasonix stats [transcript]` | One-shot cost / cache breakdown |
| `reasonix doctor` | Health check — API reach, config, hooks, project |
| `reasonix commit` | `git add -A && git commit` with an LLM-written message |
| `reasonix mcp <list\|search\|install\|inspect\|browse>` | MCP server management |
| `reasonix index` | Build the local semantic index (Ollama or OpenAI-compatible embeddings) |
| `reasonix version` / `reasonix update` | Version info + upgrade hint |

### Notable runtime flags (chat / code)

| Flag | Effect |
|---|---|
| `--no-session` | Ephemeral run — nothing is persisted |
| `--session <name>` | Resume / pin to a named session |
| `--continue` | Resume the most recent session for this workspace |
| `--new` | Force a fresh session even if one exists |
| `--budget <usd>` | Per-session USD cap — warns at 80%, refuses next turn at 100% |
| `--preset <auto\|flash\|pro>` | Model bundle (auto-escalation, locked flash, locked pro) |
| `--mcp <spec>` | Attach an MCP server for this run (repeatable) |
| `--no-config` | Ignore `~/.reasonix/config.json` for this run |
| `--no-dashboard` | Don't auto-start the embedded web dashboard |
| `--no-alt-screen` | Render to scrollback instead of the alt-screen buffer (preserves chat in shell history; legacy mode, can ghost on resize) |
| `--no-mouse` | Force SGR 1000/1006 mouse tracking off; native drag-select/right-click stays terminal-owned |

### Environment knobs

| Variable | Default | Effect |
|---|---:|---|
| `REASONIX_CONCURRENCY_PRO` | `500` | Narrow the local `deepseek-v4-pro` concurrency cap. Values above the upstream cap are clamped. |
| `REASONIX_CONCURRENCY_FLASH` | `2500` | Narrow the local `deepseek-v4-flash` concurrency cap. |
| `REASONIX_CONCURRENCY_DEFAULT` | `128` | Cap unknown DeepSeek model ids. |
| `REASONIX_CONCURRENCY_ADAPTIVE` | `1` | `0` disables 429-triggered cap degrade/restore and keeps caps fixed. |
| `REASONIX_QUEUE_GIVEUP_MS` | `60000` | Stop waiting for a local bucket slot after this many ms; retry logic then handles backoff. |
| `REASONIX_QUEUE_HINT_MS` | `2000` | Emit queued/acquired observability events only after this queue wait threshold. |
| `REASONIX_429_THROTTLE_WINDOW_MS` | `5000` | Coalesce multiple simultaneous 429s into one cap reduction per model bucket. |
| `REASONIX_429_RESTORE_INTERVAL_MS` | `60000` | Lazy restore interval for adaptive caps after the last 429. |
| `REASONIX_QUEUE_MAX_DEPTH` | `256` | Hard cap for local queued acquires per model bucket. Full queues fail fast. |

---

## Slash commands

Type `/` mid-chat to open the picker. Aliases shown in parentheses. Code-mode-only commands marked **(code)**.

### Chat ops

| Command | What it does |
|---|---|
| `/help` (`/?`) | Show the full command reference inline |
| `/new` (`/reset`, `/clear`) | Start a fresh conversation (clear context + scrollback) |
| `/retry` | Truncate and resend your last message — fresh sample |
| `/compact` | Fold older turns into a summary (cache-safe). Auto-fires at 50% ctx; this is the manual trigger |
| `/stop` | Abort the current model turn (typed alternative to Esc) |
| `/copy` | Open copy mode — mouse drag yanks a span, double-click yanks a word/path, triple-click yanks a line; `j`/`k`, `v`, `y` keep the keyboard path |
| `/mouse [on\|off\|toggle]` | Toggle terminal mouse tracking at runtime; `on` routes wheel events, `off` restores terminal-native drag-select |

### Setup

| Command | What it does |
|---|---|
| `/preset <auto\|flash\|pro>` | Switch model bundle. Bare opens picker |
| `/model <id>` | Switch DeepSeek model id. Bare opens picker |
| `/language <EN\|zh-CN>` (`/lang`) | Switch the runtime language |
| `/theme <name>` | Show or persist terminal theme. Bare opens picker |

### Info

| Command | What it does |
|---|---|
| `/status` | Current model, flags, context, session |
| `/cost [text]` | Bare → last turn's spend; with text → estimate cost of sending it next |
| `/context` | Context-window breakdown (system / tools / log / input) |
| `/stats` | Cross-session cost dashboard (today / week / month / all-time) |
| `/doctor` | Health check (api / config / api-reach / index / hooks / project) |
| `/keys` | Keyboard + mouse + copy/paste reference |
| `/feedback` | Open a GitHub issue with diagnostic info copied to clipboard |

### Extend

| Command | What it does |
|---|---|
| `/mcp` | Open the MCP hub (live + marketplace tabs) |
| `/resource [uri]` | Browse / read MCP resources |
| `/prompt [name]` | Browse / fetch MCP prompts |
| `/memory [list\|show\|forget\|clear]` | Manage pinned memory (REASONIX.md + `~/.reasonix/memory`) |
| `/skill [list\|show\|new\|<name>]` | List / run / scaffold user skills |

### Session

| Command | What it does |
|---|---|
| `/sessions` | List saved sessions (current marked with ▸) |

### Code mode

| Command | What it does |
|---|---|
| `/init [force]` | Scan project, synthesize a baseline `REASONIX.md` |
| `/apply [N\|N,M\|N-M]` | Commit pending edit blocks to disk (subset selection supported) |
| `/discard [N\|N,M\|N-M]` | Drop pending edits without writing |
| `/walk` | Step through pending edits one block at a time (git-add-p style) |
| `/undo` | Roll back the last applied edit batch |
| `/history` | List every edit batch this session |
| `/show [id]` | Dump a stored edit diff |
| `/commit "msg"` | `git add -A && git commit -m ...` |
| `/mode <review\|auto\|yolo>` | Edit-gate mode. Shift+Tab cycles |
| `/plan [on\|off]` | Toggle read-only plan mode. Submitted plans initially show a compact summary; press `Ctrl+P` in the plan confirmation modal to expand/collapse full details |
| `/checkpoint [name\|list\|forget]` | Snapshot every file the session has touched |
| `/restore <name\|id>` | Roll back to a named checkpoint |
| `/cwd <path>` (`/sandbox`) | Switch the workspace root mid-session |

### Jobs (code mode)

| Command | What it does |
|---|---|
| `/jobs` | List background jobs |
| `/kill <id>` | Stop a background job (SIGTERM → SIGKILL) |
| `/logs <id> [lines]` | Tail a job's output (default 80 lines) |

### Advanced

| Command | What it does |
|---|---|
| `/pro [off]` | Arm v4-pro for the NEXT turn only |
| `/budget [usd\|off]` | Session USD cap |
| `/search-engine <mojeek\|searxng\|metaso>` (`/se`) | Switch web search backend |
| `/hooks [reload]` | List / reload hooks |
| `/permissions [list\|add\|remove\|clear]` | Edit shell allowlist |
| `/dashboard [stop]` | Launch / stop the embedded web dashboard |
| `/loop <interval> <prompt>` | Auto-resubmit a prompt every interval |
| `/plans` | List active + archived plans |
| `/replay [N]` | Load an archived plan as a read-only Time Travel snapshot |
| `/update` | Show current vs latest version |
| `/exit` (`/quit`, `/q`) | Quit the TUI |

---

## Keyboard

| Key | What it does |
|---|---|
| `Enter` | Submit the prompt |
| `Shift+Enter` | Insert a newline in the prompt |
| `↑` / `↓` | Scroll chat history (mouse wheel routes here too) |
| `Ctrl+P` / `Ctrl+N` | Previous / next prompt history · cursor up / down in a multi-line draft. In a submitted-plan confirmation modal, `Ctrl+P` expands/collapses full plan details |
| `Ctrl+A` / `Ctrl+E` | Jump to start / end of the current line |
| `Ctrl+W` | Delete the word before the cursor |
| `Ctrl+U` | Clear the entire prompt buffer |
| `Tab` | Complete @-mention · drill folder · accept slash command |
| `Shift+Tab` | Edit-gate: toggle review ↔ AUTO mode |
| `Esc` | Dismiss picker · abort the running model turn |
| `Ctrl+C` | Cancel current input / abort the running model turn; press again quickly (~800ms) to quit (NOT copy — see clipboard) |
| `PgUp` / `PgDn` | Scroll chat history a page at a time. While plan details are expanded, scroll the bounded detail window |
| `End` | Jump chat to the most recent line |
| `Alt+M` | Toggle mouse tracking; `on` routes wheel events, `off` restores terminal-native drag-select |

### Edit-gate (code mode)

| Key | What it does |
|---|---|
| `y` / `n` | Accept / drop pending edits in the review modal |
| `Shift+Tab` | Toggle review ↔ AUTO (persisted across sessions) |
| `u` | Undo the last auto-applied batch (within the 5s banner) |

---

## Mouse

| Action | What it does |
|---|---|
| Wheel | Scrolls chat history when your terminal translates wheel input; use `/mouse on` if you need app-level routing |
| Drag | Terminal-native selection by default; with mouse tracking on, some terminals send drag as mouse reports |
| Right-click | Terminal-native by default; mouse tracking can capture it in some terminals |

Reasonix leaves SGR 1000/1006 mouse tracking off by default so plain drag-select and right-click stay owned by the terminal. If your terminal does not translate wheel input in the alternate screen, use `Alt+M`, `/mouse on`, or config `mouseTracking: true` to opt into app-level wheel routing. In that mode, plain drag may be captured by the app; use `Shift+Drag`, `Alt+M`, or `/mouse off` to return to terminal-native selection.

---

## Copy / paste

The default path is **terminal-native**. Drag to select, then use your terminal's normal copy keys. When tracking is on, use `Shift+Drag` if your terminal captures plain drag, or run `/mouse off`.

| Action | How |
|---|---|
| Select text | Drag by default; if mouse tracking is on, use `Shift+Drag` or `/mouse off` |
| Copy | `Ctrl+Shift+C` (Win / Linux) · `Cmd+C` (macOS) — or auto-copy-on-select if your terminal does it |
| Paste | `Ctrl+V` or `Ctrl+Shift+V` (Win / Linux) · `Cmd+V` (macOS) |
| Multi-line paste | Bracketed paste — pastes stay one block, no auto-submit on intermediate newlines |

### When drag-select doesn't work

In SSH / mosh / tmux, the alt-screen buffer prevents the terminal from extending the selection past the visible viewport — there is no scrollback above the alt-screen to drag into. Two fixes:

1. **`/copy`** — open copy mode in-app. Snapshots the current chat to a navigable buffer; mouse drag yanks a character span, double-click yanks a word/path segment, triple-click yanks the line, and `y` keeps the keyboard path. Clipboard writes go through OSC 52 with a temp-file fallback for terminals that don't support it.
2. **`--no-alt-screen`** — render to shell scrollback instead. Drag-select then works terminal-natively (the chat content is real lines in the scrollback above your cursor). Trade-off: redraw can ghost on resize.

### `/copy` — copy mode keys

| Key | What it does |
|---|---|
| Mouse drag | Select a visible character span and yank it on release |
| Mouse double-click | Yank the word/path segment under the pointer |
| Mouse triple-click | Yank the visible line under the pointer |
| `j` / `↓` | Cursor down one line |
| `k` / `↑` | Cursor up one line |
| `PgUp` / `PgDn` | Page up / down |
| `g` / `G` | Jump to top / bottom |
| `v` | Start (or cancel) selection at the cursor |
| `y` / `Enter` | Yank selection to clipboard, exit |
| `q` / `Esc` | Quit without yanking |

`y` with no active selection yanks just the current line. The yank goes through OSC 52 first (works through SSH, mosh, tmux with `set -g set-clipboard on`); content larger than 75 KB falls back to a temp file whose path is printed on exit.

---

## Where this lives

In-app, `/keys` and `/help` print the same content the model knows about. This page mirrors them so the reference is greppable from the repo / website.

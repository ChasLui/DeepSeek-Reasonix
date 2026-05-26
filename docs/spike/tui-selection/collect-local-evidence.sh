#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${OUT_DIR:-/tmp/reasonix-tui-selection-$stamp}"
skip_interactive="${SKIP_INTERACTIVE:-0}"

mkdir -p "$out_dir"
if [[ -f "$script_dir/manual-evidence.template.json" && ! -e "$out_dir/manual-evidence.json" ]]; then
  cp "$script_dir/manual-evidence.template.json" "$out_dir/manual-evidence.json"
  MANUAL_EVIDENCE_JSON="$out_dir/manual-evidence.json" MANUAL_EVIDENCE_OUT_DIR="$out_dir" node - <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const file = process.env.MANUAL_EVIDENCE_JSON;
const outDir = process.env.MANUAL_EVIDENCE_OUT_DIR;
const data = JSON.parse(readFileSync(file, "utf8"));
data.outDir = outDir;
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
NODE
fi

log_file="$out_dir/local-probes.log"

run_with_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local pid="$!"
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= seconds )); then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

run_logged() {
  local label="$1"
  shift
  {
    printf '\n## %s\n' "$label"
    printf '$'
    printf ' %q' "$@"
    printf '\n'
    "$@"
  } >>"$log_file" 2>&1
}

cd "$repo_root"

printf 'Writing probe artifacts to %s\n' "$out_dir"

run_logged "git branch" git branch --show-current
run_logged "git head" git rev-parse HEAD
run_logged "system" uname -a
run_logged "source version" npm run dev -- --version

gui_report="$out_dir/gui-capability.md"
{
  printf '# GUI Automation Capability\n\n'
  printf 'Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '## Environment\n\n'
  printf '```text\n'
  sw_vers || true
  printf 'TERM=%s\n' "${TERM:-}"
  printf 'TTY=%s\n' "$(tty 2>/dev/null || true)"
  printf '```\n\n'

  printf '## Terminal apps found\n\n'
  for app in \
    /System/Applications/Utilities/Terminal.app \
    /Applications/iTerm.app \
    /Applications/iTerm2.app \
    /Applications/WezTerm.app \
    /Applications/Alacritty.app \
    /Applications/Ghostty.app \
    /Applications/kitty.app; do
    if [[ -d "$app" ]]; then
      printf -- '- %s\n' "$app"
    fi
  done
  if [[ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]]; then
    ghostty_version="$out_dir/ghostty-version.txt"
    /Applications/Ghostty.app/Contents/MacOS/ghostty --version >"$ghostty_version" 2>&1 || true
    printf '\n```text\n'
    sed -n '1,40p' "$ghostty_version"
    printf '```\n'
  fi

  printf '\n## Command availability\n\n'
  printf '```text\n'
  command -v osascript screencapture tmux wezterm alacritty ghostty kitty 2>/dev/null || true
  printf '```\n\n'

  printf '## Accessibility / screenshot probes\n\n'
  accessibility_out="$out_dir/accessibility-probe.txt"
  if command -v osascript >/dev/null 2>&1; then
    if run_with_timeout 10 osascript -e 'tell application "System Events" to return UI elements enabled' >"$accessibility_out" 2>&1; then
      printf -- '- System Events UI scripting: `%s`\n' "$(tr '\n' ' ' <"$accessibility_out")"
    else
      printf -- '- System Events UI scripting: probe failed or timed out; see `accessibility-probe.txt`.\n'
    fi
  else
    printf -- '- System Events UI scripting: `osascript` unavailable.\n'
  fi

  screenshot_out="$out_dir/screencapture-probe.txt"
  screenshot_png="$out_dir/screencapture-probe.png"
  if command -v screencapture >/dev/null 2>&1; then
    if screencapture -x "$screenshot_png" >"$screenshot_out" 2>&1 && [[ -s "$screenshot_png" ]]; then
      printf -- '- `screencapture`: PASS, wrote `%s`.\n' "$screenshot_png"
    else
      printf -- '- `screencapture`: FAIL, output: `%s`\n' "$(tr '\n' ' ' <"$screenshot_out")"
      rm -f "$screenshot_png"
    fi
  else
    printf -- '- `screencapture`: unavailable.\n'
  fi

  printf '\n## Interpretation\n\n'
  printf 'This report only records whether the current session can automate GUI-terminal evidence. '
  printf 'If screenshot capture or UI scripting is unavailable, complete E0/E3/E4/FR-104 manually with `manual-terminal-checklist.md`.\n'
} >"$gui_report"

if command -v script >/dev/null 2>&1; then
  printf '\n[manual] The next probe opens Reasonix in a pseudo-terminal.\n'
  printf '[manual] Press Esc when the session picker appears to let the probe finish.\n'
  if [[ "$skip_interactive" == "1" ]]; then
    printf '[manual] SKIP_INTERACTIVE=1, skipping Reasonix PTY startup probe.\n'
  else
    script -q "$out_dir/mm-startup.log" npm run dev -- chat --no-session --no-dashboard --new --no-config
    perl -0777 -ne 'while(/\e\[\?([0-9;]+)([hl])/g){ print "?${1}${2}\n" } while(/\e\[([0-9;]*)([A-Za-z])/g){ print "CSI ${1}${2}\n" }' \
      "$out_dir/mm-startup.log" >"$out_dir/mm-sequences.txt"
  fi
  script -q "$out_dir/stty.log" stty -a >/dev/null 2>&1 || true
else
  printf 'script(1) not found; skipping PTY startup and stty probes\n' >>"$log_file"
fi

npx tsx - <<'TS' >"$out_dir/stdin-parser-probe.txt"
import { enableMouseMode, disableMouseMode } from "./src/cli/ui/mouse-mode.ts";
import { StdinReader, type KeyEvent } from "./src/cli/ui/stdin-reader.ts";

const cases: Array<[string, string]> = [
  ["SGR click", "\x1b[<0;10;5M"],
  ["SGR wheel-up", "\x1b[<64;10;5M"],
  ["SGR release", "\x1b[<0;10;5m"],
  ["X10-ish click", "\x1b[M" + String.fromCharCode(32, 42, 37)],
  ["X10-ish wheel-up", "\x1b[M" + String.fromCharCode(96, 42, 37)],
];

const originalWrite = process.stdout.write;
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
process.stdout.write = (() => true) as typeof process.stdout.write;
enableMouseMode();
process.stdout.write = originalWrite;

for (const [name, input] of cases) {
  const reader = new StdinReader();
  const events: KeyEvent[] = [];
  reader.subscribe((ev) => events.push(ev));
  reader.feed(input);
  console.log(name, JSON.stringify(events));
}

process.stdout.write = (() => true) as typeof process.stdout.write;
disableMouseMode();
process.stdout.write = originalWrite;
TS

npx tsx - <<'TS' >"$out_dir/clip-to-cells-probe.txt"
import { clipToCells, graphemeWidth, graphemes, stringWidth } from "./src/frame/width.ts";

const samples = ["abcdef", "中abcdef", "a👩‍💻b", "中"];
for (const s of samples) {
  for (let n = 1; n <= 4; n++) {
    console.log(JSON.stringify(s), n, JSON.stringify(clipToCells(s, n)), stringWidth(clipToCells(s, n)));
  }
  console.log("graphemes", graphemes(s).map((g) => `${g}:${graphemeWidth(g)}`).join("|"));
}
TS

render_dir="$out_dir/e3-render-samples"
E3_RENDER_DIR="$render_dir" npx tsx - <<'TS' >"$out_dir/e3-render-samples.log"
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chalk } from "chalk";

const outDir = process.env.E3_RENDER_DIR ?? "";
if (outDir.length === 0) throw new Error("E3_RENDER_DIR is required");
mkdirSync(outDir, { recursive: true });
const chalk = new Chalk({ level: 1 });

const samples = [
  "tool: console.log('中👩‍💻')",
  "path: /usr/local/bin/reasonix --flag=value",
  "json: {\"status\":\"ok\",\"emoji\":\"🚀\",\"cjk\":\"中文\"}",
];
const variants = [
  ["chalk-inverse", samples.map((s) => chalk.inverse(s)).join("\n")],
  ["solid-bg", samples.map((s) => `${chalk.bgYellow.black(s)}\x1b[49m`).join("\n")],
  ["raw-inverse", samples.map((s) => `\x1b[7m${s}\x1b[27m`).join("\n")],
] as const;

const combined: string[] = [];
for (const [name, body] of variants) {
  const file = join(outDir, `${name}.ansi`);
  writeFileSync(file, `${body}\n`, "utf8");
  combined.push(`\n=== ${name} ===\n${body}`);
  console.log(file);
}
writeFileSync(join(outDir, "combined.ansi"), `${combined.join("\n")}\n`, "utf8");
writeFileSync(
  join(outDir, "README.txt"),
  "Display with: cat combined.ansi\\nCapture one screenshot per terminal and record it in manual-terminal-checklist.md.\\n",
  "utf8",
);
TS

if [[ -f "$script_dir/generate-completion-audit.mjs" ]]; then
  node "$script_dir/generate-completion-audit.mjs" "$out_dir/manual-evidence.json" \
    >"$out_dir/completion-audit.md"
fi

printf 'Probe complete. Key files:\n'
find "$out_dir" -maxdepth 2 -type f -print | sort

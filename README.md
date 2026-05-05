<p align="center">
  <img src="docs/logo.svg" alt="Reasonix" width="640"/>
</p>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="https://esengine.github.io/reasonix/">Website</a>
  &nbsp;·&nbsp;
  <a href="./docs/ARCHITECTURE.md">Architecture</a>
  &nbsp;·&nbsp;
  <a href="./benchmarks/">Benchmarks</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/reasonix"><img src="https://img.shields.io/npm/v/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22" alt="npm version"/></a>
  <a href="https://github.com/esengine/reasonix/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/esengine/reasonix/ci.yml?style=flat-square&label=ci&color=0d1117&labelColor=161b22" alt="CI"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22" alt="license"/></a>
  <a href="https://www.npmjs.com/package/reasonix"><img src="https://img.shields.io/npm/dm/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22" alt="downloads"/></a>
  <a href="./package.json"><img src="https://img.shields.io/node/v/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22" alt="node"/></a>
  <a href="https://github.com/esengine/reasonix/stargazers"><img src="https://img.shields.io/github/stars/esengine/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22&logo=github" alt="GitHub stars"/></a>
  <a href="https://github.com/esengine/reasonix/graphs/contributors"><img src="https://img.shields.io/github/contributors/esengine/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22&logo=github" alt="contributors"/></a>
  <a href="https://github.com/esengine/reasonix/discussions"><img src="https://img.shields.io/github/discussions/esengine/reasonix.svg?style=flat-square&color=0d1117&labelColor=161b22&logo=github" alt="Discussions"/></a>
</p>

<br/>

<h3 align="center">A DeepSeek-native AI coding agent for your terminal.</h3>
<p align="center">Engineered around prefix-cache stability — so token costs stay low across long sessions, and you can leave it running.</p>

<br/>

<p align="center">
  <img src="docs/assets/hero-terminal.svg" alt="Reasonix code mode — assistant proposes a SEARCH/REPLACE edit; nothing on disk until /apply" width="860"/>
</p>

<br/>

> [!TIP]
> **Cache stability isn't a feature you turn on; it's an invariant the loop is designed around.** That's the whole reason Reasonix is DeepSeek-only — every layer is tuned to the byte-stable prefix-cache mechanic.

<br/>

## Install

```bash
cd my-project
npx reasonix code   # paste a DeepSeek API key on first run; persists after
```

Requires Node ≥ 22. Tested on macOS · Linux · Windows (PowerShell · Git Bash · Windows Terminal). Get a [DeepSeek API key →](https://platform.deepseek.com/api_keys) · `reasonix code --help` for flags.

<br/>

## What makes Reasonix different

The loop is organized around four pillars. Each one solves a problem generic agent frameworks don't even see — because they were designed for a different cache mechanic.

<table>
<tr>
<td width="50%" valign="top">

### 01 / Cache-first loop

Append-only history, no in-place mutation, no marker-based compaction. The byte prefix survives every tool call, so DeepSeek's prefix-cache keeps hitting turn after turn.

[Read more →](./docs/ARCHITECTURE.md#pillar-1--cache-first-loop)

</td>
<td width="50%" valign="top">

### 02 / R1 thought harvesting

R1 emits extensive `reasoning_content`. Most frameworks display and discard it. Reasonix distills it into a typed plan state — subgoals, hypotheses, uncertainties, rejected paths.

[Read more →](./docs/ARCHITECTURE.md#pillar-2--r1-thought-harvesting-opt-in)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 03 / Tool-call repair

Schema flatten, JSON repair, scavenge from `<think>`, truncation. Four strategies that handle DeepSeek-specific quirks generic loops mistake for model errors.

[Read more →](./docs/ARCHITECTURE.md#pillar-3--tool-call-repair)

</td>
<td width="50%" valign="top">

### 04 / Cost control

Cache-safe folding, aggressive-fold tier, summary-on-exit, model-aware budgets. The loop manages context size without breaking prefix stability.

[Read more →](./docs/ARCHITECTURE.md#pillar-4--cost-control-v06)

</td>
</tr>
</table>

<br/>

## Capabilities

<table>
<tr>
<td width="33%" valign="top">

#### Cell-diff renderer

Custom TUI runtime built on Yoga. No Ink dependency. Handles wide chars, emoji, bracketed paste, and resize without ghosts.

</td>
<td width="33%" valign="top">

#### MCP — first class

stdio and Streamable HTTP transports. Tools, resources, and prompts. In-app browser to inspect any server's surface.

</td>
<td width="33%" valign="top">

#### Plan mode

Review proposed edits before they touch disk. Approve, refine, or reject. Plan checkpoints persist across runs.

</td>
</tr>
<tr>
<td valign="top">

#### Permissions

`allow` · `ask` · `deny` per-tool. Granular shell command rules. Interactive prompts you can teach.

</td>
<td valign="top">

#### Embedded dashboard

Companion web view at `localhost`. Live cache hit rate, cost ticker, session timeline, MCP health.

</td>
<td valign="top">

#### Persistent sessions

Per-workspace, named, resumable. `--resume` picks up exactly where you left off — system prompt, history, plan state.

</td>
</tr>
<tr>
<td valign="top">

#### Hooks · skills · memory

Run shell on lifecycle events. Drop in skill packs. Persistent project memory the agent reads on every turn.

</td>
<td valign="top">

#### Semantic search

`reasonix index` builds an embedding index your agent can query. Local Ollama or DeepSeek-hosted.

</td>
<td valign="top">

#### Auto-checkpoints

Cursor-style session-scoped rollback for AI edits. Never pollutes git history; a checkpoint stack is yours alone.

</td>
</tr>
<tr>
<td valign="top">

#### `/effort` knob

Switch reasoning depth per turn. `max` for the gnarly, `low` for the routine. Slash command and CLI flag.

</td>
<td valign="top">

#### Transcript replay

`reasonix replay` plays a recorded session back through the renderer. Useful for bug reports and demos.

</td>
<td valign="top">

#### Event log

`events.jsonl` sidecar with reducers and a `reasonix events` CLI. Build dashboards, audits, or your own analytics.

</td>
</tr>
</table>

<br/>

## How it compares

|                                   | Reasonix         | Claude Code       | Cursor              | Aider              |
|-----------------------------------|------------------|-------------------|---------------------|--------------------|
| Backend                           | DeepSeek         | Anthropic         | OpenAI / Anthropic  | any (OpenRouter)   |
| License                           | **MIT**          | closed            | closed              | Apache 2           |
| Cost profile                      | **low per task** | premium           | subscription + use  | varies             |
| DeepSeek prefix-cache             | **engineered**   | not applicable    | not applicable      | incidental         |
| Embedded web dashboard            | yes              | —                 | n/a (IDE)           | —                  |
| Persistent per-workspace sessions | yes              | partial           | n/a                 | —                  |
| Plan mode · MCP · hooks · skills  | yes              | yes               | yes                 | partial            |
| Open community development        | yes              | —                 | —                   | yes                |

For live cache-hit rates, costs, and methodology, see [`benchmarks/`](./benchmarks/) — the numbers move with model pricing, so they live with the harness, not in the README.

<br/>

## Documentation

- [**Architecture**](./docs/ARCHITECTURE.md) — the four pillars, cache-first loop, harvesting, scaffolds
- [**Benchmarks**](./benchmarks/) — τ-bench-lite harness, transcripts, cost methodology
- [**Website**](https://esengine.github.io/reasonix/) — getting started, dashboard mockup, TUI mockup
- [**Contributing**](./CONTRIBUTING.md) — comment policy, error-handling rules, library-over-hand-rolled
- [**Code of Conduct**](./CODE_OF_CONDUCT.md) · [**Security policy**](./SECURITY.md)

<br/>

## Community

> [!NOTE]
> Reasonix is open source and community-developed. The contributors wall below isn't decoration — every avatar is a real PR that shipped.

Scoped starter tickets — each with background, code pointers, acceptance criteria, and hints — live under the [`good first issue`](https://github.com/esengine/reasonix/labels/good%20first%20issue) label. Pick anything open.

**Open Discussions — opinions wanted:**

- [#20 · CLI / TUI design](https://github.com/esengine/reasonix/discussions/20) — what's broken, what's missing, what would you change?
- [#21 · Dashboard design](https://github.com/esengine/reasonix/discussions/21) — react against the [proposed mockup](https://esengine.github.io/reasonix/design/agent-dashboard.html)
- [#22 · Future feature wishlist](https://github.com/esengine/reasonix/discussions/22) — what would you build into Reasonix next?

**Before your first PR**: read [`CONTRIBUTING.md`](./CONTRIBUTING.md) — short, strict rules (comments, errors, libraries-over-hand-rolled). `tests/comment-policy.test.ts` enforces the comment ones; `npm run verify` is the pre-push gate. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues → [SECURITY.md](./SECURITY.md).

<p align="center">
  <a href="https://github.com/esengine/reasonix/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=esengine/reasonix&max=100&columns=12" alt="Contributors to esengine/reasonix" width="860"/>
  </a>
</p>

<br/>

## Non-goals

> [!IMPORTANT]
> Reasonix is opinionated. Some things it deliberately *doesn't* do — listed here so you can pick the right tool for your work.

- **Multi-provider flexibility.** DeepSeek-only on purpose. Coupling to one backend is the feature, not a limitation.
- **IDE integration.** Terminal-first. The diff lives in `git diff`, the file tree in `ls`. The dashboard is a companion, not a Cursor replacement.
- **Hardest-leaderboard reasoning.** Claude Opus still wins some benchmarks. DeepSeek is competitive on coding; if your work is "solve this PhD proof" rather than "fix this auth bug," start with Claude.
- **Air-gapped / fully-free.** Reasonix needs a paid DeepSeek API key. For air-gapped or zero-cost runs see Aider + Ollama or [Continue](https://continue.dev).

<br/>

---

<p align="center">
  <sub>MIT — see <a href="./LICENSE">LICENSE</a></sub>
  <br/>
  <sub>Built by the community at <a href="https://github.com/esengine/reasonix/graphs/contributors">esengine/reasonix</a></sub>
</p>

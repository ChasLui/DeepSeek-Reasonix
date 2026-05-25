# Reasonix Architecture

## Design philosophy

Reasonix is **opinionated, not general**. Every abstraction is justified by a
DeepSeek-specific behavior or economic property. If it's generic, we don't
ship it.

The product north star: **coding agent that stays cheap enough to leave on**.
A tool that quietly burns $200/month on a background project is one nobody
uses. Every subsystem below is answerable to that goal.

## The four pillars

### Pillar 1 — Cache-First Loop

**Problem.** DeepSeek bills cached input at ~10% of the miss rate. Automatic
prefix caching activates only when the *exact* byte prefix of the previous
request matches. Most agent loops reorder, rewrite, or inject fresh
timestamps each turn — cache hit rate in practice: <20%.

**Solution.** Partition the context into three regions:

```
┌─────────────────────────────────────────┐
│ IMMUTABLE PREFIX                        │ ← fixed for session
│   system + tool_specs + few_shots        │   cache hit candidate
├─────────────────────────────────────────┤
│ APPEND-ONLY LOG                         │ ← grows monotonically
│   [assistant₁][tool₁][assistant₂]...    │   preserves prefix of prior turns
├─────────────────────────────────────────┤
│ VOLATILE SCRATCH                        │ ← reset each turn
│   R1 thought, transient plan state      │   never sent upstream
└─────────────────────────────────────────┘
```

**Invariants:**
1. Prefix is computed once per session, hashed, and pinned.
2. Log entries are serialized in append order; no rewrites.
3. Scratch is distilled via Pillar 2 before any information from it is folded
   into the log.

**Metric.** `prompt_cache_hit_tokens / (hit + miss)` exposed per-turn and
aggregated per-session. Visible in the TUI's top-bar cache cell.

#### Cache TTL alignment with DeepSeek docs

DeepSeek's KV cache docs snapshot (2026-05-25,
https://api-docs.deepseek.com/zh-cn/guides/kv_cache) says the cache is enabled
by default, each request can create cache-prefix units, and later requests only
hit when they completely match an already-persisted prefix unit. Prefix units
come from request end positions, detected common prefixes across requests, and
fixed token intervals for long inputs/outputs.

The docs expose `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, but
also state that the cache is best-effort, does not guarantee 100% hits, and is
cleared after an inactive lifetime generally measured in hours to days. Reasonix
therefore treats unchanged-prompt misses as `recent-miss`, `older-miss`, or
`best-effort-miss`; it does not encode a deterministic 5-minute or 1-hour
DeepSeek TTL as a product fact.

#### Parallel tool dispatch

Each tool declares `parallelSafe?: boolean` (default `false`). The loop
dispatcher groups consecutive parallel-safe calls into chunks and races
them via `Promise.allSettled`; the first non-parallel-safe call ends the
chunk and runs alone (serial barrier — read-after-write order
preserved). Tool-result yields and history append still land in declared
order regardless of which call settles first, so the model sees the
same shape it would under a fully serial dispatch.

| Env var | Default | Effect |
|---|---|---|
| `REASONIX_PARALLEL_MAX` | `3` (hard cap `16`) | Max chunk size. |
| `REASONIX_TOOL_DISPATCH=serial` | unset | Forces serial dispatch — escape hatch. |

Built-in opt-ins: read-only filesystem (`read_file`, `list_directory`,
`directory_tree`, `search_files`, `search_content`, `get_file_info`),
web (`web_search`, `web_fetch`), `recall_memory`, `semantic_search`,
isolated child loops (`run_skill`, `spawn_subagent`), in-memory job
queries (`job_output`, `list_jobs`). Mutating / side-effecting tools
stay default. MCP-bridged tools default `false` — third-party tools
opt in only when the server explicitly declares parallel safety.

#### Concurrency observer

DeepSeek rate limiting is concurrency-based: upstream currently allows
`deepseek-v4-pro=500` and `deepseek-v4-flash=2500` concurrent requests per
account. Reasonix mirrors those upstream limits by default and does not
invent a smaller local cap. The in-process `ConcurrencyBucket` is an
observation layer: it tracks `inUse`, queue depth, recent 429s, and token
state without changing prompt bytes, message order, or prefix fingerprints.

Caps can be manually narrowed with `REASONIX_CONCURRENCY_PRO`,
`REASONIX_CONCURRENCY_FLASH`, `REASONIX_CONCURRENCY_DEFAULT`, or
`rateLimit.concurrency.{pro,flash,default}`. A 429 halves the affected
model bucket once per 5s throttle window, then lazy-restores every 60s by
`ceil(cap * 1.5)` until the configured initial cap is reached. Set
`REASONIX_CONCURRENCY_ADAPTIVE=0` or
`rateLimit.concurrency.adaptive:false` to keep caps fixed and rely only on
normal retry backoff.

Queued acquisitions give up after `REASONIX_QUEUE_GIVEUP_MS` (default
60s), preserving retry time inside DeepSeek's best-effort cache lifetime
instead of burning the window in a local queue.
`REASONIX_QUEUE_HINT_MS` (default 2s) controls when queued/acquired events
are emitted for observability. Auxiliary calls still route to v4-flash
per Pillar 3, so a full flash bucket never promotes summaries or subagents
to pro just to escape a queue.

## Thinking mode contract

DeepSeek's thinking-mode docs snapshot (2026-05-25,
https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) defines the
request/response shape that Reasonix treats as a protocol contract, not a UI
preference.

Live v4-flash attestation on 2026-05-25 returned HTTP 200 with non-empty
`reasoning_content` for `thinking.type=enabled`, `thinking.type=disabled`, and
omitted thinking controls. Reasonix therefore keeps
`thinkingModeForModel("deepseek-v4-flash")` enabled and
`isThinkingModeModel("deepseek-v4-flash")` true.

**Inv-A — Tool-call round-trip.** An assistant turn that contains `tool_calls`
must keep `reasoning_content` when it is sent back in later chat calls, or the
next DeepSeek request can fail with 400. Reasonix keeps that field through
`buildAssistantMessage` (in `src/loop/messages.ts`),
`stampMissingReasoningForThinkingMode` (in `src/loop/healing.ts`),
`replaceTailAssistantMessage` (in `src/loop.ts`), and scavenge (in
`src/repair/scavenge.ts`).

**Inv-B — Sampling param silence.** In thinking mode, DeepSeek silently ignores
`temperature`, `top_p`, `presence_penalty`, and `frequency_penalty` rather than
rejecting the request. `buildPayload` (in `src/client.ts`) deliberately leaves
those fields in place so Reasonix payloads stay diffable against OpenAI-style
tooling while relying on the server's no-error contract.

**Inv-C — Third-party endpoint compatibility.** Azure-compatible endpoints can
reject DeepSeek's proprietary `extra_body.thinking.type`, so `_isAzureEndpoint`
(in `src/client.ts`) strips that field. Other third-party endpoints follow the
same compatibility path when `thinkingModeForModel()` (in
`src/loop/thinking.ts`) returns `undefined`.

Last attested against DeepSeek docs: 2026-05-25 (URL above).

### Pillar 2 — Tool-Call Repair

**Problem.** Empirical DeepSeek failure modes:
- Tool-call JSON emitted inside `<think>`, missing from the final message.
- Arguments dropped when schema has >10 params or deeply nested objects.
- Same tool called repeatedly with identical args (call-storm).
- Truncated JSON due to `max_tokens` hit mid-structure.
- Args shape close-but-wrong: `null` for optional fields, stringified arrays
  (`"[\"a\"]"`), `{}` placeholders where arrays expected, bare strings where
  arrays expected, container-CWD `/root/<file>` paths, post-training
  markdown auto-links leaking into path fields (`[notes.md](http://notes.md)`).

**Solution.** Repair runs in two layers:

**Layer A — call-level pipeline** (`src/repair/index.ts`, runs on every
assistant turn):

1. **`flatten`** — schemas with >10 leaf params or depth >2 are auto-detected
   on `ToolRegistry.register()` and presented to the model in dot-notation
   form. `dispatch()` re-nests the args before calling the user's `fn`.
2. **`scavenge`** — regex + JSON parser sweeps `reasoning_content` for any tool
   call the model forgot to emit in `tool_calls`.
3. **`truncation`** — detect unbalanced JSON and repair by closing braces or
   requesting a continuation completion.
4. **`path-normalize`** — strip leading `/root` from path-like args (DeepSeek
   trains on container CWDs where the repo sits at `/root/<repo>`); rewrites
   to project-relative.
5. **`storm`** — identical `(tool, args)` tuple within a sliding window →
   suppress the call, inject a reflection turn.

**Layer B — arg-shape repair at dispatch** (`src/repair/schema-walk.ts` +
`src/repair/arg-shape.ts`, runs once per `tools.dispatch()` call):

The inversion that matters: **validate-then-repair**, not preprocess-then-
validate. A preprocessing pass encodes a prior about what's broken and risks
silent corruption (e.g. mangling a `writeFile.content` that happens to look
like a JSON array). The validator is allowed to complain first, then repair
is spent only at the exact issue paths the schema disagreed at.

Order:

1. **Autolink unwrap** — degenerate `[X](http(s)://X)` collapses to `X` in
   any string field. Real markdown links (`[click](https://example.com)`)
   pass through because link-text ≠ URL host.
2. **`validate(schema, args)` → `Issue[]`** — lightweight JSONSchema walker
   (`required-missing` / `type-mismatch` / `array-expected`).
3. For each issue (processed **deepest-first** to keep paths stable across
   sibling mutations), apply `SHAPE_REPAIRS` in fixed order:
   1. `stripNullOnOptional` — drop `null` at optional keys. **Refuses array
      indices** — element drop changes batch semantics; leave to the tool.
   2. `coerceNumericString` — `"50"` → `50` for `type: integer/number` fields.
      Restores the lenient behavior tools used to fake in their `fn` bodies.
   3. `parseStringifiedArray` — `'["a","b"]'` → `["a","b"]` when value
      JSON-parses to an array. **Must precede** wrap-bare-string so
      `'["a","b"]'` doesn't become `['["a","b"]']`.
   4. `unwrapEmptyPlaceholderObject` — `{}` at an array field → `[]`.
   5. `wrapBareString` — `"foo"` at an array field → `["foo"]`.
4. Re-validate. Residual issues return a model-readable error listing each
   `path: expected X, got Y` so the model can self-correct on the next turn.

The walker covers JSONSchema `type` (string OR string-array), `required`,
nested `properties` and `array.items`, plus `enum` membership. `oneOf` /
`anyOf` / `allOf` are not modeled — host-side gate is best-effort.

**Opt-out.** Tools with their own runtime sanitizer (`submit_plan`,
`revise_plan`, `mark_step_complete`, `ask_choice`, `todo_write`,
`spawn_subagent`) declare `lenientArgs: true` — their dispatch skips the
gate so the tool's `fn` keeps authority over mixed-shape arrays and enum
fallbacks. **Autolink sweep still runs** for path-like fields (see scoping
below) — that's invariant-bearing and worth the tradeoff.

**Autolink scope.** `unwrapDegenerateAutolinks` only touches strings whose
direct key OR enclosing array's parent key is in `PATH_FIELD_NAMES`
(`path` / `paths` / `source` / `destination` / `file_path` / `filepath` /
`src` / `dst` / `target`). This prevents silent corruption of
`write_file.content`, `submit_plan.plan`, and other free-text fields that
might legitimately contain markdown links. The unwrap returns the
whitespace-stripped link-text (not the raw matched text), so split-domain
forms like `[src/fo o.ts](http://src/foo.ts)` resolve to `src/foo.ts`.

**Telemetry.** `ToolRegistry.getRepairStats()` exposes
`{ [toolName]: { [repairKind]: count } }`. `unregister(name)` and
`resetRepairStats([name])` clear it — important for long-lived registries
with MCP hot-add/hot-remove.

**Lenient JSON fallback (`jsonrepair`).** Every strict `JSON.parse` failure
in the repair pillar is wrapped with `tryParseLoose` (`src/repair/json-coerce.ts`):
strict first, then `jsonrepair` (ISC), then strict parse again. Single-quoted
objects, Python `True/False/None`, trailing commas, smart quotes, fenced
```json``` blocks, and truncated JSON all become recoverable. Failure
boundaries that benefit: `tools.dispatch()` arg parse, `scavenge`,
`parseStringifiedArray`, `truncation` residual. Each rescue is counted as
`jsonrepair-fallback` so its hit rate is observable. The dispatch path
additionally guards `isPlainObjectValue` — jsonrepair is permissive enough
to coerce bare text into a JSON string, which isn't a valid tool-args shape.

### Pillar 3 — Cost Control *(v0.6)*

**Problem.** Coding agents that default to the frontier model (v4-pro, ~12×
flash cost) and accumulate full tool results in context are $150-$250/month
for active users. Most turns don't need frontier reasoning; most sessions
re-pay for tool results that were only useful once.

**Solution.** Four complementary mechanisms, none of which require manual
tuning in the common case:

#### 4.1 Tiered defaults (flash-first)

The three presets trade **model tier** and **reasoning effort**:

| Preset | Model | Effort | Cost |
|---|---|---|---:|
| `flash` | `v4-flash` | `max` | 1× |
| `auto` (default) | `v4-flash` → `v4-pro` on hard turns | `max` | 1–3× |
| `pro` | `v4-pro` | `max` | ~12× |

All auxiliary calls — `forceSummaryAfterIterLimit`, subagent spawns,
truncation repair retries — hard-code `v4-flash + effort=high` regardless
of the user's preset. There's no reason to pay pro rates for "paraphrase
these tool results into prose" or for an `explore` subagent's grep chain.

#### 4.2 Turn-end auto-compaction

Every tool result in the log exceeding `TURN_END_RESULT_CAP_TOKENS` (3000)
is shrunk to that cap when a turn ends. The model had the full text for
the turn that read it; subsequent turns see a compact summary and can
re-read if needed. One extra `read_file` call is vastly cheaper than
dragging 12KB through every future prompt.

A proactive 40% context-ratio threshold runs the same shrink pre-emptively
inside long multi-iter turns before the 80% emergency threshold fires.

#### 4.3 `/pro` single-turn arming

Users who predict a hard task type `/pro`; the **next** turn runs on
`v4-pro`, then auto-disarms. No preset churn, no forgotten revert. Armed
state is visible as a yellow `⇧ pro armed` pill in the header.

#### 4.4 Failure-signal auto-escalation

The loop counts visible "flash is struggling" events per turn:
- `edit_file` / `write_file` SEARCH-not-found errors
- ToolCallRepair fires (scavenge / truncation-fix / storm-break)

Once the count hits `FAILURE_ESCALATION_THRESHOLD` (3), the **remainder of
the current turn** runs on `v4-pro`. Announced via a yellow warning row —
no silent cost surprises. Counter + escalation flag reset at every turn
start.

Header shows a red `⇧ pro escalated` pill while the turn is on pro.

#### 4.5 Read-dedup

When the model re-reads a file it already read this session, `read_file`
returns a one-line stub (`unchanged since an earlier read … content is
still above`) instead of re-dumping the body — saving the re-dump tokens.
The stub fires only when three conditions hold, so it never points the
model at content that isn't there:

1. **Same emitted view + same content.** The dedup key binds to the file's
   `dev:ino` plus the resolved view (range / head / tail / full / outline /
   aggressive). Freshness is judged by `sha256` of the bytes read on the
   same fd that would be emitted — not mtime, which a same-size edit or a
   restored timestamp can defeat.
2. **Prior output still in the active log.** This is the interaction with
   §4.2: once a read's output is shrunk by turn-end compaction or dropped
   by a history fold, the stub would be lying, so the entry is invalidated
   (the loop calls into the dedup state on every `compactInPlace`). Large
   reads that won't survive dispatch truncation are never recorded.
3. **Not forced / not disabled.** `read_file force:true` always re-dumps;
   `REASONIX_DEDUP=0` or `config.filesystem.dedupEnabled:false` disables
   the layer entirely.

State is owned per-`CacheFirstLoop`, so ACP sessions, desktop tabs, and
subagents never share read history. Concurrent identical reads in one
parallel chunk claim in declared order and all dump in full, keeping
output byte-identical across replays (Pillar 1).

#### Cost transparency

Per-turn and session cost are colored in the StatsPanel:
- `turn $0.003` — green <$0.05, yellow $0.05–0.20, red ≥$0.20
- `session $0.12` — same scale ×10

### Pillar 4 — Output Compaction *(v0.48)*

`rtk`-inspired per-command output filter that sits between `runCommand` and the
model's tool-result channel. The model rarely needs the byte-exact output of
`git status` or a passing `npm test` — what it needs is the **shape** (how many
files changed, which tests failed, where the lint errors cluster). Pillar 4
swaps the byte-blob for a structured summary and tees the original to disk
under `~/.local/share/reasonix/tee/<ts>_<slug>.log`, surfacing the path as
`[full: …]` so the model can `read_file` it on demand.

**Filter registry (`src/compact/registry.ts`).** Stateless dispatch — each
filter declares an `argv → bool` matcher and a `(input) → string|null` reducer.
First-match wins; returning `null` is passthrough; throwing is logged to
stderr, counted as `fallback`, and the model gets the untouched raw — silent
masking is explicitly avoided. Idempotent registration means
`registerShellTools` can re-register on every workspace switch without
duplicate ids.

**Tier-1 filters (high-frequency commands).**

| id | input shape | output shape | typical reduction |
|----|-------------|--------------|-------------------|
| `git-status` | porcelain or verbose status | `M:3 A:1 ?:2` + file list | 70-90% |
| `git-log` | full / oneline | `<sha> <subject>` per commit | 60-85% |
| `git-diff` | unified diff | hunks + folded unchanged blocks | 50-80% |
| `vitest` / `jest` | runner output | failures-only with stack | 90-99% on pass, 70% on fail |
| `pytest` | session output | failures section only | 85-95% |
| `cargo-test` / `go-test` | runner output | failures-only | 85-95% |
| `eslint` / `biome` / `tsc` | diagnostics | grouped by file + top rules | 60-85% |
| `ls` / `tree` / `find` | listings | extension counts + truncated head | 60-80% |

Below ~50 lines listings pass through unchanged — compaction overhead isn't
worth saving 5 tokens.

**Tee + retention.** `src/compact/tee.ts` writes the raw blob (capped at 5 MB
with a truncation marker) and FIFO-prunes the directory at 100 files.
`REASONIX_TEE=0` disables persistence; `REASONIX_TEE=<dir>` overrides the
location (used in tests). Path resolution falls back to `tmpdir()` when home
isn't writable.

**Truncation tee-back.** The 32 KB byte cap inside `runCommand` previously
dropped the tail outright. With Pillar 4 it preserves the full pre-truncation
buffer in `RunCommandResult.rawOutput`, which the dispatch layer tees. The
truncation marker now ends with `[full: <path>]` so the model can recover
the bytes it actually needed.

**Read-side: aggressive mode.** `read_file` accepts `level: "aggressive"` for
.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs — regex-based body stripper that
collapses functions/classes to `{ … }` (or `: ...` in Python) while keeping
signature lines and a stable line count. Best-effort, never AST. Trailing
hint tells the model how to re-read with `level=minimal`.

**Kill switches.** `REASONIX_COMPACT=0` bypasses the entire layer (returns
raw byte-for-byte). `REASONIX_COMPACT_EXCLUDE=git,tree` skips named
`argv[0]` heads. `config.json` has `compact: { enabled, exclude, tee }`
mirrors. Filter throws are silently swallowed → raw output, ensuring the
layer can never break a turn.

**Telemetry.** `getCompactionStats()` returns a `Map<filterId, { hits, savedBytes }>`
populated on every successful compact call. `fallback` is its own id, so a
misbehaving filter is observable without crashing the loop.

### Structured Payload Encoding — TOON

TOON sits beside Pillar 4 as the structured-data path for payloads. Protocol
envelopes stay JSON (OpenAI-compatible request bodies, JSON-RPC, JSONL records,
native tool schemas, and model-generated `arguments`), but structured payloads
inside those envelopes can be TOON.

`src/toon/codec.ts` pins TOON options (`indent=2`, comma delimiter,
`keyFolding=off`) so identical values produce identical bytes. Tool results use
`src/toon/encode-result.ts`: `ToolRegistry` encodes object returns and string
returns that are valid JSON objects/arrays; MCP text blocks go through the same
re-encode step in `flattenMcpResult`. Plain text remains plain text, and payloads
are encoded before truncation and before entering the append-only `role:"tool"`
log, so later turns resend the same bytes.

Consumers that previously reparsed JSON tool results go through
`decodeToolResultObject` (`rejectedReason`, tool summaries, lifecycle checks,
plan step completion, plan-mode rejection cards, subagent markdown unwrap, and
kernel error classification). The decoder accepts TOON first, with JSON-first
handling for `{` / `[` prefixes so the old control envelopes remain readable.

Prefix payloads use `src/toon/prompt-payload.ts` when `mode=prefix|all`:
`@mention` expansions, memory summaries, the skills index, and the `.gitignore`
block are emitted as deterministic fenced `toon` blocks. `codeSystemPrompt()` and
chat prompt builders receive the current TOON mode through their rebuild closures,
so `/new` and `/cwd` rebuild the same structured sections instead of losing or
duplicating them. `ImmutablePrefix.computeFingerprint()` deliberately remains
JSON-based because the hash is an internal cache-drift guard, not model-facing
payload.

Full-rewrite internal state can also use TOON: plan state, plan archives,
pending edits, checkpoints, semantic index metadata, and `.toon` config files all
read `.toon` first and fall back to legacy `.json`. JSONL streams and semantic
index data rows stay JSONL because they are append-only line protocols.

The layer is on by default for payloads. `REASONIX_TOON=results|prefix|all` or
`config.toon` (legacy `config.json` fallback) can narrow it, while
`REASONIX_TOON=0`, `toon: false`, or `toon: { enabled: false }` are the
byte-compatible kill switches. `doctor` reports the active TOON mode, and the
`/status` line reads encode/decode telemetry from `src/toon/stats.ts`.
Prompt-based tools-schema-as-TOON is still benchmark-gated because it would
bypass native function calling; the default payload encoder does not change that
protocol boundary.

## Persistent code-graph index (lexical+symbol+edge)

`src/index/code-graph/` is a JSON-backed fast path for code relation tools, not
a fifth pillar and not a replacement for the tree-sitter immediate path in
`src/code-query/`. The design is tracked in
`docs/plans/2026-05-24-codegraph-borrow-ral.md`.

`reasonix code-index rebuild` writes deterministic artifacts under
`.reasonix/index/code-graph/`: `nodes.json`, `edges.json`, `bm25.json`, and
`files-stamps.json`. All four files carry the same deterministic `graphHash`;
loaders recompute it from artifact payloads so mixed or edited artifacts fail
closed instead of serving partial graph state. The in-process load cache includes
artifact `ctimeMs` in its signature, so same-size rewrites do not bypass that
validation. Doctor artifact stats validate the same node, edge, and BM25 schema
before reporting counts. The builder uses a lightweight source scanner for the
index hot path; the older tree-sitter relation path remains the compatibility
oracle and fallback when artifacts are missing, stale-checking times out, or a
relation is unsupported by the graph.

Runtime lookup accelerates `find_references` for all four relations —
`callers`, `callees`, `imports`, and `importers` — and is the path
`detect_changes(includeCallers)` uses for caller expansion. The graph
persists `unresolvedRefs`, so an incremental update that adds a new file
re-resolves dangling references from older files (incremental ≡ full
rebuild for cross-file resolution).

When `buildCodeGraph` or `incrementalUpdate` throws inside a query, the
fast path records a per-root cooldown (`REASONIX_CODE_GRAPH_BUILD_COOLDOWN_MS`,
default 60s). Inside the cooldown window queries skip fresh builds and go
straight to the immediate fallback; an artifact already on disk still wins
the fast path. This prevents the 1s-timeout livelock on large repos.

`REASONIX_CODE_GRAPH=0` bypasses the entire layer, and
`REASONIX_CODE_GRAPH_BODY=1` is required before node `signature` /
`docstring` fields are written. Telemetry and doctor output only report
counts, sizes, elapsed time, and stale ratio.

## Module layout

```
src/
├── client.ts               # DeepSeek client (fetch + SSE)
├── loop.ts                 # Pillar 1 + 3 — CacheFirstLoop
├── repair/                 # Pillar 2 pipeline
│   ├── index.ts
│   ├── scavenge.ts
│   ├── flatten.ts
│   ├── truncation.ts
│   └── storm.ts
├── prompt-fragments.ts     # TUI_FORMATTING_RULES, NEGATIVE_CLAIM_RULE —
│                           #   reused by main + subagent + skill prompts
├── code/prompt.ts          # reasonix code main system prompt
├── compact/                # Pillar 4 — per-command output filter + tee
│   ├── registry.ts         # registerCompactor / applyCompactor + stats
│   ├── defaults.ts         # one-shot Tier-1 registration
│   ├── tee.ts              # raw-output FIFO snapshot store
│   └── filters/            # git, test-runner, linter, listing (ANSI via npm strip-ansi)
├── tools/                  # Tool implementations
│   ├── filesystem.ts       # read / list / search / edit / write
│   ├── shell.ts            # run_command + run_background (JobRegistry)
│   ├── jobs.ts             # background-process registry
│   ├── memory.ts           # remember / forget / list user memories
│   ├── skills.ts           # list + invoke SKILL.md playbooks
│   ├── subagent.ts         # spawn_subagent — flash+high by default
│   ├── plan.ts             # submit_plan (review gate)
│   └── web.ts              # web_search, web_fetch (multi-engine: Mojeek, SearXNG or Metaso)
├── mcp/                    # MCP client + bridge (stdio + SSE)
├── index/code-graph/       # JSON code-graph fast path for relation tools
├── memory.ts               # ImmutablePrefix / AppendOnlyLog / VolatileScratch
├── project-memory.ts       # REASONIX.md loader
├── user-memory.ts          # ~/.reasonix/memory/ store (project + global)
├── skills.ts               # built-in explore + research skills
├── session.ts              # JSONL session persistence
├── telemetry.ts            # cost + cache-hit accounting + SessionSummary
├── tokenizer.ts            # DeepSeek V3 tokenizer (ported)
├── usage.ts                # ~/.reasonix/usage.jsonl roll-up
├── types.ts                # ChatMessage, ToolCall, ToolSpec
├── index.ts                # library barrel
└── cli/
    ├── index.ts            # commander entry
    ├── resolve.ts          # config + CLI flag precedence
    ├── commands/           # chat, code, run, stats, sessions, ...
    └── ui/
        ├── App.tsx                  # root Ink component (~1984 LOC, was 2931)
        ├── LiveRows.tsx             # spinner rows (OngoingTool / Status / ...)
        ├── EventLog.tsx             # Historical row rendering
        ├── StatsPanel.tsx           # top bar + cost badges
        ├── PromptInput.tsx          # cursor-aware multi-line input
        ├── PlanConfirm.tsx          # submit_plan review modal
        ├── ShellConfirm.tsx         # run_command approval modal
        ├── EditConfirm.tsx          # per-edit review modal
        ├── markdown.tsx             # Ink-native markdown renderer
        ├── edit-history.ts          # EditHistoryEntry + formatters
        ├── useEditHistory.ts        # /undo, /history, /show state machine
        ├── useCompletionPickers.ts  # slash, @, slash-arg pickers
        ├── useSessionInfo.ts        # balance + models + updates fetch
        ├── useSubagent.ts           # subagent sink wiring
        └── slash/                   # /-command implementation
            ├── types.ts             # SlashContext, SlashResult, ...
            ├── commands.ts          # SLASH_COMMANDS data + parse + suggest
            ├── helpers.ts           # git, memory, token formatters
            ├── dispatch.ts          # registry + handleSlash lookup
            └── handlers/            # per-topic: basic, mcp, memory,
                                     # skill, admin, observability, edits,
                                     # jobs, sessions, model (/pro lives here)
```

Files kept small by design: the largest module under `cli/ui/` is 2K
lines (App.tsx), every handler under `slash/handlers/` is ≤200 lines,
every hook under `cli/ui/` is ≤310 lines. Adding a new slash command
means editing one handler file and one registry line.

## Design evolution

- **v0.0.x** — Pillar 1 end-to-end, repair pipeline complete, Ink TUI scaffold.
- **v0.1** — τ-bench numbers published, streaming polish, transcript replay.
- **v0.3** — MCP client (stdio + SSE), session persistence.
- **v0.4.x** — `reasonix code` with SEARCH/REPLACE edits, review/auto
  gate, background jobs, hooks.
- **v0.5.x** — V4 model support, skills, memory, subagents, actionable
  error messages.
- **v0.6** —
  - **Cost control** (flash-first defaults, auto-compaction, `/pro` one-shot,
    failure-triggered escalation, cost badges).
  - `deepseek-chat` / `deepseek-reasoner` scheduled for deprecation —
    all user-facing surfaces updated to `v4-flash` / `v4-pro`.
  - Shared prompt fragments (`TUI_FORMATTING_RULES`, `NEGATIVE_CLAIM_RULE`).
  - UI refactor: App.tsx split into 6 hooks/components, slash.ts split
    into 13 per-topic modules.
- **v0.31** *(current)* — `branch` + `harvest` features removed entirely
  (the parallel-sample selector and Pillar 2 plan-state extractor); both
  rarely paid for themselves and bloated the slash surface.

## Explicit non-goals

- Multi-agent orchestration as a first-class concept (subagents are a
  cost-reduction mechanism, not a coordination primitive).
- RAG / vector retrieval.
- Support for non-DeepSeek backends (an OpenAI-compatible shim would
  work today via `--model` override, but is not tested).
- Web UI / SaaS.
- Automatic cost escalation without user-visible announcement. Every
  pro-tier model call is surfaced; silent escalation was considered
  and rejected.

# Repository Guidelines

> Also read [`REASONIX.md`](./REASONIX.md) (working knowledge), [`CONTRIBUTING.md`](./CONTRIBUTING.md) (code rules — strictly enforced), and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (four pillars). This file is the index; those are the source of truth.

## What this is

Reasonix is a DeepSeek-native coding agent (CLI + TUI + Tauri desktop). The architecture is **opinionated, not generic** — every abstraction exists because DeepSeek's prefix-cache mechanic or pricing demanded it. Do not generalize for "future providers"; the project explicitly rejects multi-provider support.

Node ≥ 22, TS 5.6+ ES2022 ESM, Vitest, Biome, tsup. npm workspaces (`packages/core-utils` is the only sub-workspace; `desktop/` is a separate sibling project).

## Working mode (read before editing)

Four behavioral rules, derived from [Karpathy's LLM-coding pitfalls](https://github.com/multica-ai/andrej-karpathy-skills) and specialized for this strict, single-provider stack. Detailed anchors live in [`CLAUDE.md`](./CLAUDE.md#working-principles).

1. **Think before coding** — surface assumptions; if multiple interpretations exist, ask. Before borrowing or planning, grep the authoritative source (`docs/ARCHITECTURE.md`, current `HEAD`) — memory and prior plans drift.
2. **Simplicity first** — minimum code that solves the actual ask. No speculative features, no "future-provider" abstractions, no error handling for impossible scenarios.
3. **Surgical changes** — every changed line must trace to the user request. Match existing style. Don't reformat adjacent code or run bare `biome --write` (scope creep cerebrum-recorded 2026-05-25).
4. **Goal-driven execution** — convert "fix the bug" into "write a failing test, then make it pass." For multi-step work, write the plan first with explicit verify checkpoints (`bin/plan-lint.sh` enforces this for RAL plans).

Bias: **caution over speed** for anything touching `src/loop.ts`, `src/repair/`, `src/tools/`, `src/mcp/`. For trivial single-line fixes, use judgment.

## Project Structure & Module Organization

Main source lives in `src/`: `src/cli/` holds CLI commands and Ink UI, `src/tools/` tool definitions, `src/mcp/` MCP clients and transports, `src/core/` the event kernel, `src/ports/` interfaces, `src/adapters/` implementations. Tests are flat Vitest files in `tests/*.test.ts`; shared helpers live in `tests/helpers/`. `dashboard/` is the web dashboard, `desktop/` the Tauri app, `benchmarks/` evaluation harnesses, `packages/*` npm workspaces. Treat `dist/`, coverage output, and `.reasonix/semantic/` as generated.

### Layout — where things live

| Path | Role |
|---|---|
| `src/loop.ts` | CacheFirstLoop (Pillar 1 + 3 entry point) — the brain |
| `src/client.ts` | DeepSeek client (fetch + SSE streaming) |
| `src/repair/` | Pillar 2 passes (`flatten`, `scavenge`, `truncation`, `storm`) |
| `src/compact/` | Pillar 4 — per-command output filter + tee (rtk-style) |
| `src/tools/` | Tool defs — filesystem, shell, MCP bridge, plan, subagent, web, memory, skills, jobs |
| `src/mcp/` | MCP client + transports (stdio + SSE + Streamable HTTP), registry |
| `src/core/` | Event-log kernel — `events.ts` union, `reducers.ts` pure projections |
| `src/ports/` + `src/adapters/` | Port interfaces + concrete impls (e.g. `event-sink-jsonl.ts`) |
| `src/code/edit-blocks.ts` | SEARCH/REPLACE parser + apply gate — **byte-for-byte exact match** |
| `src/index/` | Local semantic vector index (`reasonix index`) |
| `src/index/code-graph/` | JSON code-graph fast path for `find_references` / `impact`; immediate `src/code-query/` remains fallback |
| `src/frame/` | Cell-grid → ANSI renderer used by the TUI log |
| `src/memory/` + `src/transcript/` + `src/telemetry/` | Persistence layers |
| `src/net/` | Proxy / no-proxy resolution |
| `src/server/` | Dashboard HTTP + REST API |
| `src/cli/commands/` | `chat`, `code`, `run`, `doctor`, `replay`, `stats`, `events`, `index`, `mcp`, `prune-sessions`, `update` |
| `src/cli/ui/` | Ink TUI. `App.tsx` is the root; `slash/handlers/` is one file per topic |
| `src/cli/ui/slash/handlers/` | Per-topic slash handlers (≤200 LOC each). Adding a slash command = one handler file + one registry line in `commands.ts` |
| `packages/core-utils` | Shared bits used across CLI / Desktop / Dashboard / ACP (`derive-prefix`, `tildeify`, `tool-kind`, `permission-types`) — `noExternal` bundled by tsup |
| `desktop/` | Tauri 2 client (separate package, React 19, Vite) |
| `dashboard/` | Browser SPA — built into `dashboard/dist/` by tsup, served by `src/server/` |
| `benchmarks/` | τ-bench + harvest harnesses. CI smoke-tests `--dry` (no LLM calls) |
| `tests/` | Flat Vitest layout. `tests/comment-policy.test.ts` enforces the comment rules |
| `dist/`, `.reasonix/semantic/`, `sessions/`, `.reasonix/sessions/` | **Generated / user-private — never hand-edit** |

## Build, Test, and Development Commands

```sh
npm install                # Node 22+ workspace deps
npm run dev                # tsx src/cli/index.ts (live source)
npm run chat               # tsx src/cli/index.ts chat
npm run build              # tsup → dist/ (+ dashboard vendor css copy)
npm run lint               # biome check src tests
npm run lint:fix
npm run format
npm run typecheck          # tsc --noEmit && tsc --noEmit -p dashboard
npm run test               # vitest run
npm run test:watch
npm run test:coverage      # v8, what CI runs
npm run test:mutation      # stryker
npm run verify             # build + lint + typecheck + test  (pre-push gate)
```

Run a single test file: `npx vitest run tests/loop.test.ts`. Filter by name: `npx vitest run -t "scavenge"`. Tests live flat in `tests/**/*.test.ts(x)` (no nested mirror of `src/`), with `tests/setup-lang.ts` as global setup and `retry: 1` to absorb Windows scheduler hiccups — a real failure still re-fails on retry.

Desktop (separate workspace, not part of root build): `cd desktop && npm install && npm run tauri dev` (or `npm run dev` / `npm run build`).

## Architecture — the four pillars

Edits to `src/loop.ts`, `src/repair/`, `src/tools/`, `src/mcp/` affect every session. Test before touching.

1. **Cache-first loop** (`src/loop.ts`, `src/memory.ts`). Context is partitioned into **immutable prefix** (hashed + pinned for the session), **append-only log** (no rewrites — reordering breaks DeepSeek prefix-cache), and **volatile scratch** (reset each turn, never sent upstream). Anything that rewrites earlier turns is a cache-correctness bug, not a feature.
2. **Tool-call repair** (`src/repair/`). Four passes — `flatten` (schemas with >10 leaf params or depth >2 auto-dot-notated at registry time, re-nested at dispatch), `scavenge` (regex sweep of `reasoning_content` for forgotten `tool_calls`), `truncation` (close unbalanced JSON or request continuation), `storm` (suppress identical `(tool, args)` within a sliding window). These are DeepSeek failure modes, not generic safety nets.
3. **Cost control** (`src/loop.ts` + `src/cli/ui/slash/handlers/`). Tiered defaults (`flash` / `auto` / `pro`), turn-end auto-compaction at `TURN_END_RESULT_CAP_TOKENS=3000`, `/pro` one-shot arming, failure-signal auto-escalation at threshold 3. Auxiliary calls (summary after iter limit, subagent spawns, repair retries) **hard-code `v4-flash + effort=high`** regardless of preset — never bill pro rates for paraphrasing.
4. **Parallel tool dispatch**. Tools opt in via `parallelSafe?: boolean` (default `false`). Read-only FS / web / memory / `recall_memory` / `semantic_search` / isolated child loops are the built-in opt-ins. MCP-bridged tools default `false` unless the server declares parallel safety. Env: `REASONIX_PARALLEL_MAX=3` (cap 16), `REASONIX_TOOL_DISPATCH=serial` escape hatch.
5. **Output compaction** (`src/compact/`, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#pillar-4--output-compaction-v048)). `rtk`-inspired per-command filter for `run_command` output (git status/log/diff, vitest/jest/pytest/cargo/go test, eslint/biome/tsc, ls/tree/find) + tee-to-disk for the raw bytes. `read_file` adds `level: "aggressive"` (regex signature extractor) for ts/js/py/go/rs. Disable with `REASONIX_COMPACT=0` / `compact.enabled=false`; tee disable with `REASONIX_TEE=0`. All filters are fail-safe — throws fall back to raw.

## Coding Style & Naming Conventions

Strict TypeScript, named exports, explicit `import type` for type-only imports. Biome enforces 2-space indentation, double quotes, semicolons, trailing commas, 100-column formatting. Prefer focused files with one responsibility; avoid `index.ts` barrels unless they meaningfully shrink the public surface. Comments explain non-obvious *why* only.

## Code rules (enforced — read `CONTRIBUTING.md`)

`tests/comment-policy.test.ts` runs in `npm run verify` and **gates pre-push**.

- **Comments default to none.** Only when *why* is non-obvious (hidden constraint, workaround, invariant the type system can't express). No "what" comments. One line max — multi-line means the code itself needs clarification.
- **No module-level docstrings, section banners (`// ─── helpers ───`), conversation history (`// user reported X`), or restated `@param` docs.**
- **TypeScript strict.** `noUncheckedIndexedAccess`, `noImplicitOverride`. No `any` without a `// biome-ignore` and a reason.
- **Libraries over hand-rolled.** Visual width → `string-width`. Grapheme segmentation → `Intl.Segmenter`. Color → `theme.ts` constants, not raw hex.
- **Error handling.** Boundary code validates (user input, network, FS). Internal code trusts. No try/catch for "internal" errors. No graceful fallback silently masking bugs — log + crash > silent wrong output.
- **Imports.** Explicit `import type` for type-only. No barrel re-exports. Named exports only — no `export default`. Entry: `src/index.ts`.
- **Files.** One responsibility per file. Don't create new `*.md` docs unless asked. Don't touch `CHANGELOG.md` (maintainer-only at release time).

## Conventions to internalize

- **Edit gate is byte-exact.** `src/code/edit-blocks.ts` rejects any SEARCH block whose bytes don't match the file exactly — trailing whitespace, indent depth, line endings all matter. Read the file fresh before constructing edits.
- **Append-only log.** When adding a feature that touches the conversation log, additions go at the tail. Anything that rewrites earlier turns invalidates DeepSeek's prefix cache and breaks the cost story.
- **Auxiliary LLM calls.** Anything not user-facing (summaries, subagents, repair retries) uses `v4-flash + effort=high`. Do not honor the user's preset for these.
- **Slash commands.** One handler per topic in `src/cli/ui/slash/handlers/`. Register in `commands.ts`. Don't grow `App.tsx`.
- **MCP transports** implement the `McpTransport` interface. Tools register through the registry at startup. Don't wire MCP servers directly into the loop.
- **Shared prompt fragments** live in `src/prompt-fragments.ts` (`TUI_FORMATTING_RULES`, `NEGATIVE_CLAIM_RULE`) — reuse them across main / subagent / skill prompts; don't paste duplicates.

## Testing Guidelines

Vitest 2.x with `describe`, `it`, `expect` (`globals: false` — import them). Name tests `<module>.test.ts` flat in `tests/`. Focus on regressions, invariants, edge cases, and boundary behavior — not type signatures or coverage bumps. `tests/fixtures/` and `tests/helpers/` are shared scaffolds; `tests/repair/` mirrors the repair pipeline. CI runs on Node 22 (Ubuntu + Windows), then smoke-tests the τ-bench runner with `--dry` (no `DEEPSEEK_API_KEY` needed). Run targeted tests while developing, then `npm run verify`.

## Commit & Pull Request Guidelines

Imperative conventional style with scopes — e.g. `fix(cli): handle empty prompt`, `feat(net): honor NO_PROXY`. One logical change per commit; separate refactors from behavior changes. PRs state what changed, why, and how to verify. Link issues, include screenshots for UI changes, ensure `npm run verify` passes, do not edit `CHANGELOG.md`, and **do not add `Co-Authored-By: Claude` trailers**.

## Security & Configuration Tips

Keep secrets out of source. Use `.env.example` for documented variables, local `.env` files for private values. Validate user input, filesystem paths, and network data at boundaries; avoid silent fallbacks that hide broken behavior.

## Things to leave alone

- `dist/` — tsup output, regenerated.
- `.reasonix/semantic/` — auto-generated vector index.
- `sessions/`, `.reasonix/sessions/` — user-private, gitignored.
- `data/deepseek-tokenizer.json.gz` — shipped tokenizer asset.
- `dashboard/codemirror.js` — vendored, biome-ignored.
- `CHANGELOG.md` — maintainer-only.

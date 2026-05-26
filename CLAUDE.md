# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check `.wolf/cerebrum.md` before generating code. Check `.wolf/anatomy.md` before reading files.

## Working principles

Derived from Karpathy's four LLM-coding pitfalls ([multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)), specialized for this repo's strict, opinionated, DeepSeek-only stack.

**1. Think before coding.** Surface assumptions; don't pick silently between interpretations. Before any non-trivial plan or borrow, **grep the authoritative source first** (e.g. `docs/ARCHITECTURE.md`, `AGENTS.md`, current `HEAD`) — memory snapshots may be stale.

- Anchor: cerebrum `plan-drafting-antipatterns` (v2 epistemological vaporware, API-primitive-out-of-thin-air), `plan-attestation-before-fr-design`, `plan-borrow-authoritative-grep-first`.
- Apply when: drafting RAL plans, borrowing from another repo, deciding on a refactor scope.

**2. Simplicity first.** Minimum code that solves the actual ask. No speculative features, no "future-provider" abstractions, no error handling for impossible scenarios. AGENTS.md says it plainly: *"the architecture is opinionated, not generic — every abstraction exists because DeepSeek's prefix-cache mechanic or pricing demanded it."*

- Anchor: AGENTS.md "Architecture — the four pillars", CONTRIBUTING.md "Libraries over hand-rolled".
- Apply when: tempted to parameterize, add config flags, or wrap a one-shot in a helper.

**3. Surgical changes.** Touch only what the request requires. Match existing style. Don't reformat adjacent code. If you spot unrelated dead code, mention it — don't delete it. Every changed line must trace to the ask.

- Anchor: cerebrum `biome-write-expands-commit` (2026-05-25 — `biome --write` swept the repo, expanded a 27-file commit to 60). The bash-guard hook now warns on bare `biome --write`.
- Apply when: running formatters, refactoring, removing imports — limit scope before acting.

**4. Goal-driven execution.** Convert vague asks ("fix the bug", "make it faster") into a verifiable checklist before writing code:

```text
1. <step> → verify: <command/test that confirms>
2. <step> → verify: <…>
```

Strong success criteria let you loop without re-asking. For plans: use `maos:ralplan` skill or `bin/plan-lint.sh` to enforce RAL structure (FRs, NFRs, slices, attestation).

- Anchor: existing RAL plans under `docs/plans/`, `bin/plan-lint.sh`.
- Apply when: any task longer than 2 tool calls, especially plan/borrow/refactor work.

**Tradeoff stated:** these principles bias toward caution. For trivial single-line fixes, use judgment. For anything that touches `src/loop.ts`, `src/repair/`, `src/tools/`, `src/mcp/`, follow them strictly — those edits affect every session.

## Memory subsystems — division of labor

Three persistent stores, three different scopes. Don't duplicate; if a fact fits two, write it where consumers look first and link from the other.

| Store | Path | Scope | When to write |
| --- | --- | --- | --- |
| **auto-memory** | `~/.claude/projects/-Users-chao-liu-...-DeepSeek-Reasonix/memory/` | Cross-session **facts**: user/feedback/project/reference. Each ≤150-char index entry. | User correction, surprising approval, new fact about external system |
| **`.wolf/cerebrum.md`** | repo (gitignored) | Cross-session **patterns**: Do-Not-Repeat / User Preferences / Key Learnings / Decision Log | OPENWOLF protocol mandates after corrections, project-convention discovery, architectural decisions |
| **`.wolf/memory.md`** | repo (gitignored) | Per-session **timeline**: `\| time \| action \| file \| outcome \| ~tokens \|` | Auto-appended by session-start + post-write hooks |
| **`.wolf/anatomy.md`** | repo (gitignored) | File index: 1-line description + token est per file | post-write hook auto-maintains (skips `../` paths after 2026-05-26 fix) |
| **`.wolf/buglog.json`** | repo (gitignored) | Bug fixes: error → root_cause → fix → tags. **Lookup-before-fix mandatory.** | Any bug fix, failed test, repeated edit on same file |
| **`.serena/memories/`** | repo (gitignored) | Code-layer symbol knowledge (LSP-derived). Currently empty by design. | Reserved for `mcp__serena__write_memory` ts/rust symbol notes |

## Active hooks (.claude/settings.json → .wolf/hooks/)

| Event | Script | Purpose |
| --- | --- | --- |
| SessionStart | session-start.js + session-start-serena.js | Init `_session.json`, cerebrum/buglog freshness reminders, Serena load-order hint |
| UserPromptSubmit | user-prompt-submit.js | Surface memory.md tail when idle >4h, cerebrum staleness warn |
| PreToolUse:Read | pre-read.js | Anatomy lookup + repeat-read warn + Serena symbol-first suggestion |
| PreToolUse:Write\|Edit\|MultiEdit | pre-write.js | Cerebrum Do-Not-Repeat check + buglog same-file lookup |
| PreToolUse:Bash | pre-bash.js | Warn on `git push origin main`, `--no-verify`, `--force`, bare `biome --write`, `.env` exposure, destructive `rm`/`reset --hard` |
| PreToolUse:mcp__serena__* | pre-serena.js | Track symbol-tool calls, suggest find_symbol over Read |
| PostToolUse:Read | post-read.js | Token estimate, update `_session.json` |
| PostToolUse:Write\|Edit\|MultiEdit | post-write.js | **Skip `../` cross-projectRoot writes (2026-05-26 fix)**, update anatomy + memory |
| Stop | stop.js | Per-turn ledger flush, multi-edit buglog reminder, cerebrum staleness check |
| SessionEnd | session-end.js | Heavy work: ledger rotation when >500KB / >100 sessions, buglog size warn |
| SubagentStop | subagent-stop.js | Detect main-worktree HEAD/status drift from spawned subagents |

`statusLine` shows: `🐺 Nr/Nw · hit:N · dedup:N · serena:N · cer:Xh · ~Nk saved`.

## Serena (LSP backend)

`.mcp.json` registers Serena MCP. `.serena/project.yml` ignores `.wolf/`, `.maos/`, `.codex/`, `.gemini/`, `.claude/` plus standard build outputs. Prefer `mcp__serena__get_symbols_overview` / `find_symbol` / `find_referencing_symbols` over full `Read` for `.ts`/`.rs` sources.

See [`AGENTS.md`](./AGENTS.md) for repo layout, build commands, and the four-pillar architecture.

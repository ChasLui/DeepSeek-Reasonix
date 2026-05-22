# Serena Memory Index — DeepSeek-Reasonix

> Companion to `.wolf/cerebrum.md`. Division of labor:
>
> | Where | What goes here |
> |---|---|
> | `.serena/memories/` (this dir) | **Code-layer** knowledge: symbol maps, cross-file dependencies, framework patterns, API shapes |
> | `.wolf/cerebrum.md` | **Session-layer** knowledge: user preferences, do-not-repeat, decision log |
> | `.wolf/anatomy.md` | File-level index: 2-3 line description + token estimate per file |
> | `.wolf/buglog.json` | Concrete bugs + root-cause + fix |

## Conventions

- Name files `NN-topic.md` (e.g. `10-tool-dispatch.md`, `20-mcp-transport.md`).
- One module / subsystem per memory. Keep under ~3KB; split if larger.
- Lead with: scope (paths), entry symbols, invariants. End with cross-refs to anatomy / cerebrum entries.
- Update via `mcp__serena__write_memory` so the LSP index stays in sync.

## Cross-references

- OpenWolf protocol: `.wolf/OPENWOLF.md`
- File anatomy: `.wolf/anatomy.md`
- Learnings: `.wolf/cerebrum.md`

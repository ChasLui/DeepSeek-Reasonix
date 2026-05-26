# E6 User Research Brief: current selection/copy demand

Status: PARTIAL. This is included because v2 requires current user research before v3, even though the standalone spike file places it just before v3 drafting rather than inside E0-E5.

## Data sources checked

### GitHub issues

Commands:

```sh
gh issue list --search 'select OR selection OR mouse OR copy' --limit 30 --json number,title,state,updatedAt,url
gh issue view 1337 --json number,title,body,url,author,createdAt,state,comments
gh issue view 514 --json number,title,body,url,author,createdAt,state,comments
```

Observed:

```text
the 'ChasLui/DeepSeek-Reasonix' repository has disabled issues
```

Result: no issue bodies or recent issue counts available through `gh`.

### Git history

Relevant commits found:

```text
1b853df fix(tui): drop xterm mouse tracking — restore native copy/paste, rebind keys (#514)
bd61890 perf(tui): lower streaming flush from 30Hz to 20Hz default (#515)
8bec37f fix(tui): enable DECSET 1007 alternate-scroll so wheel scrolls on cloud/web terminals
dd26f30 feat(tui): re-enable SGR mouse wheel by default (revisit #514) (#1262)
2ace8fd fix(cli): add opt-out for terminal mouse tracking (#1345)
```

Interpretation:

- There is clear historical churn around selection/copy vs wheel behavior.
- The strongest repo-local evidence is qualitative, not enough to compute the v2 ">=80% users" threshold.

### Telemetry

No project telemetry source for `--no-mouse`, `mouseTracking:false`, or `/copy` usage was identified in this pass. I did not inspect user-private session contents for this report.

## Current source contradiction

Before the resumed default-off fix, docs/i18n claimed native selection was unaffected:

```text
docs/CLI-REFERENCE.md:193: Reasonix sets DECSET 1007 (alternate-scroll) only ...
src/i18n/EN.ts:118-120: drag -> select text — terminal-native, no modifier needed
src/i18n/EN.ts:250: SGR mouse tracking is on by default and stays out of the way of native drag-select and right-click.
```

E1 proved that the prior source startup emitted `?1000h` and `?1006h`, which captures mouse reports and conflicted with those docs. Current source now resolves this by keeping mouse tracking off by default and requiring explicit opt-in for app-level wheel routing.

## Recommendation for v3

Before v3 implementation:

- Keep docs/source aligned on native drag-select as the default and SGR mouse tracking as explicit opt-in.
- If no product telemetry exists, do not use the ">=80% users" threshold as a hard gate.
- Use the historical evidence plus E0-E4 terminal data to choose between:
  - hint-only,
  - runtime toggle + hints,
  - parser work for X10/Path E,
  - CopyMode mouse selection.

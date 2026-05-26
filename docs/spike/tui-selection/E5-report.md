# E5 Report: sourcemap LICENSE / owner contact

Status: RESOLVED FOR CURRENT BRANCH. Local repository inspection found no explicit
license, so copying/vendor remains prohibited; the current branch uses an
independent implementation and contains no `src`/`tests` references to
`sourcemap`, `selection.ts`, or `claude-code-sourcemap`. Owner/legal approval is
only required for future vendoring.

## Local source inspected

Repository:

```text
/Users/chao.liu/my-clone/git.singularity-ai.com/chao.liu/claude-code-sourcemap
origin git@git.singularity-ai.com:chao.liu/claude-code-sourcemap.git
```

`package.json` evidence:

```text
1: {
2:   "name": "@chao.liu/my-cc",
3:   "version": "2.1.88-alpha.1",
...
11:   "publishConfig": {
12:     "registry": "https://npm.singularity-ai.com/"
13:   },
```

Search command:

```sh
rg -n '"license"|LICENSE|MIT|Apache|BSD|Copyright' \
  /Users/chao.liu/my-clone/git.singularity-ai.com/chao.liu/claude-code-sourcemap \
  --glob 'package.json' --glob 'LICENSE*' --glob 'README*'
```

Observed: no matches.

## Selection implementation exists

`src/ink/selection.ts` contains the expected concepts:

```text
79: export function startSelection(...)
97: if (!s.isDragging) return
98-103: first motion at anchor cell is a no-op
107: export function finishSelection(...)
133: const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u
613: export function selectionBounds(...)
625: export function isCellSelected(...)
674: Extract text from the screen buffer within the selection range.
804: export function applySelectionOverlay(...)
```

## Finding

No explicit license is present in the local sourcemap repo files inspected. Treat
code copying/vendor as not approved until owner or legal approval exists.

## Current branch implementation audit

Command:

```sh
rg -n "sourcemap|selection\.ts|claude-code-sourcemap" src tests
```

Observed: no matches.

`src/cli/ui/copy-mode/cell-selection.ts` imports only local Reasonix modules:

```text
../../../frame/width.js
./snapshot.js
```

The module implements local cell normalization, range extraction, word range,
whole-line range, and yank helpers. There is no vendor import, copied source
file, or dependency on the local sourcemap repository in the current code path.

## Recommendation for v3

- Keep v2's safer path: use sourcemap only as conceptual inspiration and independently implement any tiny pure state machine needed in Reasonix.
- Do not vendor `selection.ts`.
- The current branch already follows the independent implementation path; E5 is
  not a current blocker for this branch.
- If the project wants to reuse actual source text in the future, contact the
  owner and record a written license/authorization before implementation.

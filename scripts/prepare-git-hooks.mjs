// Install git hooks via simple-git-hooks, but only in a real repository root.
// In a git worktree (or submodule) `.git` is a file pointer, not a directory,
// so simple-git-hooks cannot create `.git/hooks` and errors with ENOTDIR.
// Hooks installed in the main repo are shared by all worktrees, so skipping here
// is correct, not a workaround.
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';

let isRealRepoRoot = false;
try {
  isRealRepoRoot = statSync('.git').isDirectory();
} catch {
  // No .git at all (e.g. installed as a dependency) — nothing to do.
}

if (!isRealRepoRoot) {
  console.log('[prepare] skipping git hooks: not a repository root (worktree/submodule or no .git)');
  process.exit(0);
}

try {
  execSync('simple-git-hooks', { stdio: 'inherit' });
} catch {
  // Match the previous `simple-git-hooks || true` behavior: never fail install.
}

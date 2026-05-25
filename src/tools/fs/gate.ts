/** Central FS gate — symlink default-deny + canonical-path validation.
 *  See docs/plans/2026-05-20-just-bash-sandbox-borrow.md Task 4. */

import { promises as fs, constants as fsConstants } from "node:fs";
import * as pathMod from "node:path";

export interface GateOptions {
  /** When true, skip symlink-traversal detection. Default false (deny). */
  allowSymlinks?: boolean;
}

/** Resolve `abs` under `root`, rejecting symlink traversal (unless allowed); returns the
 * canonical real path. Throws Error with code ENOENT/EACCES so callers detect via err.code. */
export async function resolveAndValidate(
  abs: string,
  root: string,
  opts: GateOptions = {},
): Promise<string> {
  const allowSymlinks = opts.allowSymlinks === true;
  // Always resolve root to its canonical form once — caller may pass a path
  // that itself includes a symlink (e.g. /var → /private/var on macOS) and we
  // don't want every comparison to fail because of that.
  const canonicalRoot = await fs.realpath(root).catch(() => root);
  // For the candidate, lstat first to keep "file doesn't exist" distinguishable
  // from "symlink encountered". When `allowSymlinks=true` we skip the check and
  // just resolve to whatever realpath returns.
  if (allowSymlinks) {
    return await fs.realpath(abs).catch(() => abs);
  }
  let canonical: string;
  try {
    canonical = await fs.realpath(abs);
  } catch (err) {
    // ENOENT: path doesn't exist — caller handles (this is a new-file write
    // path; check the parent dir for symlinks instead).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return await resolveParent(abs, canonicalRoot, allowSymlinks);
    }
    throw err;
  }
  // The canonical resolution should differ from `abs` only in case-normalization,
  // /private prefix (macOS), or trailing slash. If the relative path under
  // canonicalRoot differs from the relative path the caller asked for, a
  // symlink was crossed.
  const rel = pathMod.relative(canonicalRoot, canonical);
  if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
    const e = new Error(`symlink traversal denied: ${abs} → ${canonical}`);
    (e as NodeJS.ErrnoException).code = "EACCES";
    throw e;
  }
  return canonical;
}

/** New-file write: candidate doesn't exist yet, but the parent dir must still be inside root. */
async function resolveParent(
  abs: string,
  canonicalRoot: string,
  allowSymlinks: boolean,
): Promise<string> {
  const parent = pathMod.dirname(abs);
  const canonicalParent = allowSymlinks
    ? await fs.realpath(parent).catch(() => parent)
    : await fs.realpath(parent);
  const rel = pathMod.relative(canonicalRoot, canonicalParent);
  if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
    const e = new Error(`symlink traversal denied (parent): ${parent} → ${canonicalParent}`);
    (e as NodeJS.ErrnoException).code = "EACCES";
    throw e;
  }
  return pathMod.join(canonicalParent, pathMod.basename(abs));
}

/** O_NOFOLLOW flag value — read from Node because numeric values vary by platform. */
export function noFollowFlag(): number | undefined {
  if (process.platform === "win32") return undefined;
  return fsConstants.O_NOFOLLOW;
}

/** Convenience: write whole file content, refusing to follow symlinks. POSIX uses O_NOFOLLOW;
 *  Windows pre-checks via lstat. Mirrors `fs.writeFile(abs, content, "utf8")` semantics otherwise. */
export async function writeFileNoFollow(abs: string, content: string): Promise<void> {
  const handle = await openForWriteNoFollow(abs);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Convenience: open for write with O_NOFOLLOW on POSIX; Windows callers must do lstat first. */
export async function openForWriteNoFollow(abs: string): Promise<fs.FileHandle> {
  const nf = noFollowFlag();
  if (nf === undefined) {
    // Windows fallback — lstat first; reject symlinks before opening.
    const stat = await fs.lstat(abs).catch(() => null);
    if (stat?.isSymbolicLink()) {
      const e = new Error(`symlink write denied (windows fallback): ${abs}`);
      (e as NodeJS.ErrnoException).code = "EPERM";
      throw e;
    }
    return await fs.open(abs, "w");
  }
  return await fs.open(abs, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | nf);
}

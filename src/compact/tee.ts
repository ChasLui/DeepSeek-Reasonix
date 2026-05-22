/** Save raw command output to a side-file the model can read with `read_file`. */

import { promises as fs } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

/** Cap on a single tee file so a runaway process doesn't fill the disk. */
const MAX_RAW_BYTES = 5 * 1024 * 1024;

/** FIFO retention — oldest beyond this many files is pruned on each save. */
const MAX_FILES = 100;

/** Disabled when set to "0" / "false". Other values treated as the override directory. */
const ENV_FLAG = "REASONIX_TEE";

let cachedDir: string | null = null;
let cachedDisabled = false;

function resolveTeeDir(): string | null {
  if (cachedDisabled) return null;
  if (cachedDir) return cachedDir;
  const env = process.env[ENV_FLAG];
  if (env === "0" || env === "false") {
    cachedDisabled = true;
    return null;
  }
  if (env && env !== "1" && env !== "true") {
    cachedDir = env;
    return cachedDir;
  }
  // Default location: ~/.local/share/reasonix/tee on POSIX,
  // %LOCALAPPDATA%\reasonix\tee on Windows. Falls back to tmpdir if neither resolves.
  const home = homedir() || tmpdir();
  if (platform() === "win32") {
    cachedDir = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "reasonix", "tee")
      : join(home, "AppData", "Local", "reasonix", "tee");
  } else {
    cachedDir = join(home, ".local", "share", "reasonix", "tee");
  }
  return cachedDir;
}

/** Reset cached state — exported for tests that flip the env var mid-run. */
export function resetTeeCache(): void {
  cachedDir = null;
  cachedDisabled = false;
}

function slugify(cmd: string): string {
  const head = cmd.trim().slice(0, 40);
  return (
    head
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "cmd"
  );
}

async function pruneFifo(dir: string): Promise<void> {
  let entries: { name: string; mtime: number }[];
  try {
    const names = await fs.readdir(dir);
    entries = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await fs.stat(join(dir, name))).mtimeMs,
      })),
    );
  } catch {
    return;
  }
  if (entries.length <= MAX_FILES) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  const drop = entries.slice(0, entries.length - MAX_FILES);
  await Promise.all(drop.map((e) => fs.unlink(join(dir, e.name)).catch(() => {})));
}

export interface TeeWriteOptions {
  /** Override the destination directory (tests / config). */
  overrideDir?: string;
  /** Skip writing even when env says otherwise. */
  disabled?: boolean;
}

/** Persist `raw` and return the absolute path, or null on disabled / write failure. */
export async function teeRawOutput(
  cmd: string,
  raw: string,
  opts: TeeWriteOptions = {},
): Promise<string | null> {
  if (opts.disabled) return null;
  if (!raw) return null;
  const dir = opts.overrideDir ?? resolveTeeDir();
  if (!dir) return null;
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const stamp = Date.now();
  const filename = `${stamp}_${slugify(cmd)}.log`;
  const path = join(dir, filename);
  let body = raw;
  if (Buffer.byteLength(body, "utf8") > MAX_RAW_BYTES) {
    body = `${body.slice(0, MAX_RAW_BYTES)}\n[… tee truncated at ${MAX_RAW_BYTES} bytes …]`;
  }
  try {
    await fs.writeFile(path, body, "utf8");
  } catch {
    return null;
  }
  pruneFifo(dir).catch(() => {});
  return path;
}

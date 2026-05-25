import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CodeGraphFileStamp } from "./types.js";

export interface DiffStaleStampsResult {
  stale: string[];
  checked: number;
  total: number;
  timedOut: boolean;
  elapsedMs: number;
}

export interface DiffStaleStampsOptions {
  timeoutMs?: number;
  statFile?: (path: string) => Promise<CodeGraphFileStat>;
  listFiles?: (root: string) => Promise<readonly string[]>;
}

const DEFAULT_STALE_TIMEOUT_MS = 200;

type CodeGraphFileStat = Pick<CodeGraphFileStamp, "mtimeMs" | "size"> & {
  isFile?: () => boolean;
  isSymbolicLink?: () => boolean;
};

export async function diffStaleStamps(
  root: string,
  stamps: Record<string, CodeGraphFileStamp>,
  opts: DiffStaleStampsOptions = {},
): Promise<DiffStaleStampsResult> {
  const started = performance.now();
  const total = Object.keys(stamps).length;
  const timeoutMs = opts.timeoutMs ?? parseTimeoutEnv();
  if (timeoutMs <= 0) {
    return { stale: [], checked: 0, total, timedOut: true, elapsedMs: 0 };
  }
  return Promise.race([
    scanStamps(root, stamps, opts, started),
    timeoutResult(timeoutMs, total, started),
  ]);
}

async function scanStamps(
  root: string,
  stamps: Record<string, CodeGraphFileStamp>,
  opts: DiffStaleStampsOptions,
  started: number,
): Promise<DiffStaleStampsResult> {
  const absRoot = resolve(root);
  const stale: string[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const [path, stamp] of Object.entries(stamps).sort(([a], [b]) => a.localeCompare(b))) {
    seen.add(path);
    checked += 1;
    const target = resolve(absRoot, path);
    if (!isInsideRoot(absRoot, target)) {
      stale.push(path);
      continue;
    }
    try {
      const current = await (opts.statFile ?? lstat)(target);
      if (
        current.isSymbolicLink?.() ||
        current.isFile?.() === false ||
        current.size !== stamp.size ||
        Math.abs(current.mtimeMs - stamp.mtimeMs) > 1
      ) {
        stale.push(path);
      }
    } catch {
      stale.push(path);
    }
  }
  if (opts.listFiles) {
    for (const path of normalizeCurrentPaths(absRoot, await opts.listFiles(absRoot))) {
      if (seen.has(path)) continue;
      seen.add(path);
      stale.push(path);
    }
  }
  return {
    stale: stale.sort((a, b) => a.localeCompare(b)),
    checked,
    total: seen.size,
    timedOut: false,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function normalizeCurrentPaths(root: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!isInsideRoot(root, target)) continue;
    const rel = relative(root, target).replaceAll("\\", "/");
    if (rel) out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function timeoutResult(
  timeoutMs: number,
  total: number,
  started: number,
): Promise<DiffStaleStampsResult> {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs));
  return {
    stale: [],
    checked: 0,
    total,
    timedOut: true,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function parseTimeoutEnv(): number {
  const raw = process.env.REASONIX_CODE_GRAPH_STALE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_STALE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_STALE_TIMEOUT_MS;
}

/** Background index maintenance for Pillar 5 (Slices 1–3): recursively watch each active workspace, debounce changes, then maintain its retrieval indexes (code-graph incremental every flush; lexical/semantic full rebuilds throttled per root; idle prebuild). Writes only file-backed derived state under .reasonix/index, never a session prefix/log — zero Pillar-1 risk (INV-P1). */

import { type Dirent, watch as fsWatch, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SKIP_DIR_NAMES, incrementalUpdate } from "../index/code-graph/builder.js";
import { loadCodeGraph } from "../index/code-graph/loader.js";
import { buildCodeLexicalIndex } from "../index/lexical/code.js";
import { buildIndex as buildSemanticIndex, indexExists } from "../index/semantic/builder.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

/** Coalesce a burst of saves into one maintenance pass. */
const DEFAULT_DEBOUNCE_MS = 500;
/** Throttle the expensive full rebuilds (lexical/semantic) per workspace. */
const DEFAULT_BG_COOLDOWN_MS = 30_000;

function resolveMs(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Pluggable watcher — defaults to a cross-platform recursive watch; tests inject a fake. Returns a closer. */
export type WatchFactory = (
  root: string,
  onChange: (file: string) => void,
) => { close: () => void };

/** Low-level per-directory watch primitives — injected so the recursive walk is testable without real fs events. */
export interface WatchPrimitives {
  /** Immediate non-skipped, non-symlink child directories of `dir`. */
  listDirs: (dir: string) => string[];
  /** Watch a single directory (non-recursive); the callback gets the changed entry name (or null). */
  watchDir: (dir: string, onEvent: (name: string | null) => void) => { close: () => void };
}

/** Pluggable incremental code-graph updater — defaults to loadCodeGraph + incrementalUpdate. */
export type GraphUpdater = (root: string, staleFiles: string[]) => Promise<void>;
/** Pluggable full-rebuild updater for lexical/semantic — defaults wrap the real builders. */
export type IndexUpdater = (root: string) => Promise<void>;

export interface IndexMaintainerOptions {
  debounceMs?: number;
  /** Per-root throttle for the expensive lexical/semantic rebuilds. */
  bgCooldownMs?: number;
  watch?: WatchFactory;
  updateGraph?: GraphUpdater;
  updateLexical?: IndexUpdater;
  updateSemantic?: IndexUpdater;
  /** Clock seam (default Date.now) — injected so throttling is testable without real time. */
  now?: () => number;
  /** Surface background errors (default: swallow — best-effort maintenance must never crash the daemon). */
  onError?: (root: string, err: unknown) => void;
}

interface WorkspaceWatch {
  watcher: { close: () => void };
  staleSet: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/** Immediate child directories of `dir`, excluding SKIP_DIR_NAMES + symlinks so node_modules/.git are never watched (P1-I / NF-106). Exported for testing. */
export function listWatchableDirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIR_NAMES.has(e.name))
    .map((e) => join(dir, e.name));
}

const realPrims: WatchPrimitives = {
  listDirs: listWatchableDirs,
  watchDir: (dir, onEvent) => {
    const w = fsWatch(dir, (_event, name) => onEvent(name ? String(name) : null));
    return { close: () => w.close() };
  },
};

/** Recursively watch `root` + every non-skipped subdirectory, picking up newly-created dirs. Unifies platforms (fs.watch `recursive` is macOS/Windows-only) and excludes SKIP_DIR_NAMES + symlinks so node_modules/.git never blow up CPU (P1-I). */
export function recursiveWatch(
  root: string,
  onChange: (file: string) => void,
  prims: WatchPrimitives = realPrims,
): { close: () => void } {
  const watched = new Map<string, { close: () => void }>();
  const watch = (dir: string): void => {
    if (watched.has(dir)) return;
    watched.set(
      dir,
      prims.watchDir(dir, (name) => {
        if (name) onChange(relative(root, join(dir, name)) || name);
        // A change may have created a new subdir — rescan this dir's children.
        for (const sub of prims.listDirs(dir)) watch(sub);
      }),
    );
    for (const sub of prims.listDirs(dir)) watch(sub);
  };
  watch(root);
  return {
    close: () => {
      for (const w of watched.values()) w.close();
      watched.clear();
    },
  };
}

const defaultWatch: WatchFactory = (root, onChange) => recursiveWatch(root, onChange);

const defaultUpdateGraph: GraphUpdater = async (root, staleFiles) => {
  const graph = await loadCodeGraph(root);
  // No graph built yet → leave first construction to the lazy path on change events
  // (idle prebuild may cold-build lexical, but code-graph stays change-driven).
  if (!graph) return;
  await incrementalUpdate(root, graph, staleFiles);
};

const defaultUpdateLexical: IndexUpdater = async (root) => {
  // Direct call bypasses openOrBuild's existing-fast-return + shared cooldown Map (P1-E).
  await buildCodeLexicalIndex(root);
};

const defaultUpdateSemantic: IndexUpdater = async (root) => {
  // INV-P5-3: only maintain an EXISTING semantic index — never cold-build (embedder-optional).
  if (!(await indexExists(root))) return;
  // Throws if the embedder is gone (ollama down) → caller's catch → onError, then skipped.
  await buildSemanticIndex(root);
};

export class IndexMaintainer {
  private readonly watches = new Map<string, WorkspaceWatch>();
  private readonly lastHeavy = new Map<string, number>();
  private readonly unsubs: Array<() => void> = [];
  private readonly debounceMs: number;
  private readonly bgCooldownMs: number;
  private readonly watchFn: WatchFactory;
  private readonly updateGraph: GraphUpdater;
  private readonly updateLexical: IndexUpdater;
  private readonly updateSemantic: IndexUpdater;
  private readonly now: () => number;
  private readonly onError: (root: string, err: unknown) => void;

  constructor(lifecycle: WorkspaceLifecycle, opts: IndexMaintainerOptions = {}) {
    this.debounceMs =
      opts.debounceMs ?? resolveMs("REASONIX_INDEX_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
    this.bgCooldownMs =
      opts.bgCooldownMs ?? resolveMs("REASONIX_INDEX_BG_COOLDOWN_MS", DEFAULT_BG_COOLDOWN_MS);
    this.watchFn = opts.watch ?? defaultWatch;
    this.updateGraph = opts.updateGraph ?? defaultUpdateGraph;
    this.updateLexical = opts.updateLexical ?? defaultUpdateLexical;
    this.updateSemantic = opts.updateSemantic ?? defaultUpdateSemantic;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    this.unsubs.push(lifecycle.onOpened((root) => this.start(root)));
    this.unsubs.push(lifecycle.onClosed((root) => this.stop(root)));
    this.unsubs.push(lifecycle.onIdle((root) => this.prebuild(root)));
  }

  /** Per-workspace maintenance status for the daemon status endpoint (Slice 3). */
  status(): Array<{
    root: string;
    pendingStale: number;
    lastHeavyMs: number | null;
  }> {
    return [...this.watches.entries()].map(([root, ws]) => ({
      root,
      pendingStale: ws.staleSet.size,
      lastHeavyMs: this.lastHeavy.get(root) ?? null,
    }));
  }

  /** Roots currently watched (tests/status). */
  watchedRoots(): string[] {
    return [...this.watches.keys()];
  }

  private start(root: string): void {
    if (this.watches.has(root)) return;
    const ws: WorkspaceWatch = {
      watcher: { close: () => {} },
      staleSet: new Set(),
      debounceTimer: null,
    };
    try {
      ws.watcher = this.watchFn(root, (file) => this.onChange(root, ws, file));
    } catch (err) {
      // watch start failed (path gone, fd limit) — degrade silently.
      this.onError(root, err);
      return;
    }
    this.watches.set(root, ws);
  }

  private onChange(root: string, ws: WorkspaceWatch, file: string): void {
    // Every watch event's path enters the stale set; a rename surfaces as two
    // events (old path removed + new path added), so both are covered (P1-F).
    ws.staleSet.add(file);
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
    ws.debounceTimer = setTimeout(() => this.flush(root, ws), this.debounceMs);
    ws.debounceTimer.unref?.();
  }

  private flush(root: string, ws: WorkspaceWatch): void {
    ws.debounceTimer = null;
    if (ws.staleSet.size === 0) return;
    const stale = [...ws.staleSet];
    ws.staleSet.clear();
    // code-graph: cheap true-incremental, every flush.
    void this.updateGraph(root, stale).catch((err) => this.onError(root, err));
    // lexical + semantic: expensive full rebuilds, throttled per root.
    this.maybeHeavy(root);
  }

  /** Idle prebuild: refresh the expensive indexes proactively (still throttled, so repeated idle ticks don't rebuild). code-graph stays change-driven. */
  private prebuild(root: string): void {
    this.maybeHeavy(root);
  }

  /** Run the throttled lexical + semantic full rebuilds if the per-root cooldown has elapsed. */
  private maybeHeavy(root: string): void {
    const now = this.now();
    if (now - (this.lastHeavy.get(root) ?? 0) < this.bgCooldownMs) return;
    this.lastHeavy.set(root, now);
    void this.updateLexical(root).catch((err) => this.onError(root, err));
    void this.updateSemantic(root).catch((err) => this.onError(root, err));
  }

  private stop(root: string): void {
    const ws = this.watches.get(root);
    if (!ws) return;
    // Clear the debounce timer BEFORE closing the watcher (P1-H) so no pending
    // flush fires against a released workspace.
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
    ws.watcher.close();
    this.watches.delete(root);
    this.lastHeavy.delete(root);
  }

  /** Stop all watchers + unsubscribe from lifecycle (daemon shutdown). */
  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const root of [...this.watches.keys()]) this.stop(root);
  }
}

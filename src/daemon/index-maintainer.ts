/** Background index maintenance for Pillar 5 (Slice 1). Subscribes to WorkspaceLifecycle: when a workspace's first session opens, watch its source tree; on file changes, debounce then feed the changed paths to code-graph's incremental update. When the last session detaches, release the watcher. incrementalUpdate writes to disk; the next find_code/loadCodeGraph picks it up via the on-disk signature — there is NO cache write-back (graphCache is module-private and self-invalidates by lstat signature). Maintains only file-backed derived state under .reasonix/index — never any session's immutable prefix or append-only log (INV-P1), so zero Pillar-1 risk. */

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { incrementalUpdate } from "../index/code-graph/builder.js";
import { loadCodeGraph } from "../index/code-graph/loader.js";
import type { WorkspaceLifecycle } from "./workspace-lifecycle.js";

/** Coalesce a burst of saves into one incremental pass. */
const DEFAULT_DEBOUNCE_MS = 500;

function resolveDebounceMs(): number {
  const raw = process.env.REASONIX_INDEX_DEBOUNCE_MS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEBOUNCE_MS;
}

/** Pluggable watcher — defaults to recursive fs.watch; tests inject a fake, and Slice 3 swaps in a Linux-recursive implementation that also applies SKIP_DIR_NAMES. Returns a closer. */
export type WatchFactory = (
  root: string,
  onChange: (file: string) => void,
) => { close: () => void };

/** Pluggable incremental updater — defaults to loadCodeGraph + incrementalUpdate. */
export type GraphUpdater = (root: string, staleFiles: string[]) => Promise<void>;

export interface IndexMaintainerOptions {
  debounceMs?: number;
  watch?: WatchFactory;
  updateGraph?: GraphUpdater;
  /** Surface background errors (default: swallow — best-effort maintenance must never crash the daemon). */
  onError?: (root: string, err: unknown) => void;
}

interface WorkspaceWatch {
  watcher: { close: () => void };
  staleSet: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const defaultWatch: WatchFactory = (root, onChange) => {
  // recursive is supported on macOS/Windows; Linux falls back in Slice 3.
  const w: FSWatcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (filename) onChange(String(filename));
  });
  return { close: () => w.close() };
};

const defaultUpdateGraph: GraphUpdater = async (root, staleFiles) => {
  const graph = await loadCodeGraph(root);
  // No graph built yet → leave first construction to the lazy path; the
  // background never cold-builds (respects Pillar 5's lazy-by-default posture).
  if (!graph) return;
  await incrementalUpdate(root, graph, staleFiles);
};

export class IndexMaintainer {
  private readonly watches = new Map<string, WorkspaceWatch>();
  private readonly unsubs: Array<() => void> = [];
  private readonly debounceMs: number;
  private readonly watchFn: WatchFactory;
  private readonly updateGraph: GraphUpdater;
  private readonly onError: (root: string, err: unknown) => void;

  constructor(lifecycle: WorkspaceLifecycle, opts: IndexMaintainerOptions = {}) {
    this.debounceMs = opts.debounceMs ?? resolveDebounceMs();
    this.watchFn = opts.watch ?? defaultWatch;
    this.updateGraph = opts.updateGraph ?? defaultUpdateGraph;
    this.onError = opts.onError ?? (() => {});
    this.unsubs.push(lifecycle.onOpened((root) => this.start(root)));
    this.unsubs.push(lifecycle.onClosed((root) => this.stop(root)));
    // Idle prebuild (lifecycle.onIdle) is wired in Slice 2.
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
      // recursive watch unsupported (Linux, Slice 3) or path gone — degrade silently.
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
    // Background, best-effort: incrementalUpdate writes to disk; the next
    // loadCodeGraph picks it up via on-disk signature (no cache write-back).
    void this.updateGraph(root, stale).catch((err) => this.onError(root, err));
  }

  private stop(root: string): void {
    const ws = this.watches.get(root);
    if (!ws) return;
    // Clear the debounce timer BEFORE closing the watcher (P1-H) so no pending
    // flush fires against a released workspace.
    if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
    ws.watcher.close();
    this.watches.delete(root);
  }

  /** Stop all watchers + unsubscribe from lifecycle (daemon shutdown). */
  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const root of [...this.watches.keys()]) this.stop(root);
  }
}

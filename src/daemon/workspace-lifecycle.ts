/** Per-workspace session lifecycle for the daemon. The daemon's own idle timer is whole-process (fires only at zero sessions); this adds the per-workspace granularity it otherwise lacks: how many live sessions and in-flight long RPCs each workspace root has. Emits `opened` when a root's first session arrives, `closed` when its last session detaches, and `idle` when a root still has sessions but no in-flight work for a quiet window. Pillar 5 background indexing (IndexMaintainer, Slice 1+) subscribes to drive watcher start/stop and idle prebuild. Pure bookkeeping — no loop/retrieval coupling, zero Pillar risk. */

type RootCallback = (root: string) => void;

interface WorkspaceState {
  /** Live sessions rooted here. Only `session/new` increments and `detach` decrements — `session/cancel` keeps the session alive, so it must NOT touch this (else the watcher releases under a still-open session). */
  refcount: number;
  /** In-flight long RPCs across this root's sessions (prompt/chat/compact/balance). Drives the "busy" signal — NOT just the prompt aborter, which would miss chat/compact/balance and misfire idle prebuild while they run. */
  busyOps: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
}

export class WorkspaceLifecycle {
  private readonly byRoot = new Map<string, WorkspaceState>();
  private readonly openedCbs: RootCallback[] = [];
  private readonly closedCbs: RootCallback[] = [];
  private readonly idleCbs: RootCallback[] = [];

  /** @param quietMs idle window in ms; 0 disables `idle` emission entirely. */
  constructor(private readonly quietMs = 0) {}

  /** Subscribe to "a root's first session opened" (refcount 0→1). Returns an unsubscribe. */
  onOpened(cb: RootCallback): () => void {
    this.openedCbs.push(cb);
    return () => this.remove(this.openedCbs, cb);
  }

  /** Subscribe to "a root's last session detached". Returns an unsubscribe. */
  onClosed(cb: RootCallback): () => void {
    this.closedCbs.push(cb);
    return () => this.remove(this.closedCbs, cb);
  }

  /** Subscribe to "a root has sessions but went quiet for quietMs". Returns an unsubscribe. */
  onIdle(cb: RootCallback): () => void {
    this.idleCbs.push(cb);
    return () => this.remove(this.idleCbs, cb);
  }

  /** A new session opened at `root` (session/new). Emits `opened` on the 0→1 transition. */
  onSessionOpen(root: string): void {
    const st = this.ensure(root);
    const wasIdle = st.refcount === 0;
    st.refcount++;
    if (wasIdle) this.emit(this.openedCbs, root);
    this.armQuiet(root, st);
  }

  /** A session at `root` was removed (detach ONLY — not cancel). Emits `closed` when the root's last session goes. */
  onSessionClose(root: string): void {
    const st = this.byRoot.get(root);
    if (!st) return;
    st.refcount--;
    if (st.refcount > 0) {
      this.armQuiet(root, st);
      return;
    }
    this.disarmQuiet(st);
    this.byRoot.delete(root);
    this.emit(this.closedCbs, root);
  }

  /** A long RPC started at `root` (prompt/chat/compact/balance) — marks the root busy. */
  onRpcStart(root: string): void {
    const st = this.byRoot.get(root);
    if (!st) return;
    st.busyOps++;
    this.disarmQuiet(st);
  }

  /** A long RPC at `root` finished — re-arms the quiet timer if the root is now idle. */
  onRpcEnd(root: string): void {
    const st = this.byRoot.get(root);
    if (!st) return;
    st.busyOps = Math.max(0, st.busyOps - 1);
    this.armQuiet(root, st);
  }

  /** Clear every pending timer (daemon shutdown). */
  dispose(): void {
    for (const st of this.byRoot.values()) this.disarmQuiet(st);
    this.byRoot.clear();
  }

  /** Live session count for a root (status endpoint + tests). */
  refcountOf(root: string): number {
    return this.byRoot.get(root)?.refcount ?? 0;
  }

  /** In-flight long-RPC count for a root (status endpoint + tests). */
  busyOpsOf(root: string): number {
    return this.byRoot.get(root)?.busyOps ?? 0;
  }

  /** Roots with at least one live session. */
  activeRoots(): string[] {
    return [...this.byRoot.keys()];
  }

  private ensure(root: string): WorkspaceState {
    let st = this.byRoot.get(root);
    if (!st) {
      st = { refcount: 0, busyOps: 0, quietTimer: null };
      this.byRoot.set(root, st);
    }
    return st;
  }

  /** Re-arm the quiet timer iff the root is idle (has sessions, no in-flight RPC). Always clears any prior timer so the window restarts from the latest activity. */
  private armQuiet(root: string, st: WorkspaceState): void {
    this.disarmQuiet(st);
    if (this.quietMs <= 0 || st.refcount <= 0 || st.busyOps > 0) return;
    st.quietTimer = setTimeout(() => {
      st.quietTimer = null;
      // B3: re-check live state in the callback, never the arm-time snapshot.
      if (this.byRoot.get(root) === st && st.refcount > 0 && st.busyOps === 0) {
        this.emit(this.idleCbs, root);
      }
    }, this.quietMs);
    st.quietTimer.unref?.();
  }

  private disarmQuiet(st: WorkspaceState): void {
    if (st.quietTimer) {
      clearTimeout(st.quietTimer);
      st.quietTimer = null;
    }
  }

  private emit(cbs: RootCallback[], root: string): void {
    for (const cb of [...cbs]) cb(root);
  }

  private remove(cbs: RootCallback[], cb: RootCallback): void {
    const i = cbs.indexOf(cb);
    if (i >= 0) cbs.splice(i, 1);
  }
}

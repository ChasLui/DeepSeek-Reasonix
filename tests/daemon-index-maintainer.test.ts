/** IndexMaintainer (Slices 1–2) — fs-watch → debounce → code-graph incremental (every flush) + throttled lexical/semantic full rebuilds + idle prebuild, driven by WorkspaceLifecycle. Fake watch + spy updaters + injected clock isolate the logic from the platform/filesystem and real time. */

import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GraphUpdater,
  IndexMaintainer,
  type WatchFactory,
  type WatchPrimitives,
  listWatchableDirs,
  recursiveWatch,
} from "../src/daemon/index-maintainer.js";
import { WorkspaceLifecycle } from "../src/daemon/workspace-lifecycle.js";

/** A fake watcher whose change events we drive manually. */
function fakeWatch() {
  const emitters = new Map<string, (file: string) => void>();
  let closed = 0;
  const factory: WatchFactory = (root, onChange) => {
    emitters.set(root, onChange);
    return {
      close: () => {
        closed++;
        emitters.delete(root);
      },
    };
  };
  return {
    factory,
    fire: (root: string, file: string) => emitters.get(root)?.(file),
    isWatching: (root: string) => emitters.has(root),
    closedCount: () => closed,
  };
}

const noop = async () => {};

describe("IndexMaintainer — watch lifecycle", () => {
  it("starts a watcher when a workspace opens, releases it when it closes", () => {
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      updateGraph: noop,
    });
    lc.onSessionOpen("/a");
    expect(im.watchedRoots()).toEqual(["/a"]);
    expect(fw.isWatching("/a")).toBe(true);
    lc.onSessionClose("/a");
    expect(im.watchedRoots()).toEqual([]);
    expect(fw.closedCount()).toBe(1);
    im.dispose();
  });

  it("does not double-watch a root with a second session", () => {
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      updateGraph: noop,
    });
    lc.onSessionOpen("/a");
    lc.onSessionOpen("/a"); // 2nd session — onOpened only fired on the 0→1 transition
    expect(im.watchedRoots()).toEqual(["/a"]);
    lc.onSessionClose("/a"); // still one session → not released
    expect(im.watchedRoots()).toEqual(["/a"]);
    lc.onSessionClose("/a"); // last session → released
    expect(im.watchedRoots()).toEqual([]);
    im.dispose();
  });

  it("degrades silently when the watcher factory throws (e.g. recursive unsupported)", () => {
    const lc = new WorkspaceLifecycle();
    const errors: unknown[] = [];
    const im = new IndexMaintainer(lc, {
      watch: () => {
        throw new Error("ENOTSUP");
      },
      updateGraph: noop,
      onError: (_r, e) => errors.push(e),
    });
    lc.onSessionOpen("/a");
    expect(im.watchedRoots()).toEqual([]); // start failed → no watcher registered
    expect((errors[0] as Error).message).toBe("ENOTSUP");
    im.dispose();
  });

  it("dispose unsubscribes from lifecycle — later opens don't start watchers", () => {
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      updateGraph: noop,
    });
    im.dispose();
    lc.onSessionOpen("/a");
    expect(im.watchedRoots()).toEqual([]);
    expect(fw.isWatching("/a")).toBe(false);
  });
});

describe("IndexMaintainer — debounce + code-graph incremental", () => {
  afterEach(() => vi.useRealTimers());

  /** Heavy (lexical/semantic) updaters are stubbed so these tests isolate the code-graph + debounce path. */
  function build(
    lc: WorkspaceLifecycle,
    fw: ReturnType<typeof fakeWatch>,
    updateGraph: GraphUpdater,
  ) {
    return new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      updateGraph,
      updateLexical: noop,
      updateSemantic: noop,
    });
  }

  it("debounces a burst into one update with the union of changed paths", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: Array<{ root: string; stale: string[] }> = [];
    const m = build(lc, fw, async (root, stale) => {
      calls.push({ root, stale });
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "x.ts");
    fw.fire("/a", "y.ts");
    fw.fire("/a", "x.ts"); // duplicate collapses
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([]); // still inside the debounce window
    vi.advanceTimersByTime(50);
    expect(calls.length).toBe(1);
    expect(calls[0].root).toBe("/a");
    expect(calls[0].stale.sort()).toEqual(["x.ts", "y.ts"]);
    m.dispose();
  });

  it("covers a rename's old AND new path — both watch events enter the stale set (P1-F)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const m = build(lc, fw, async (_root, stale) => {
      calls.push(stale);
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "old.ts"); // rename → old path removed
    fw.fire("/a", "new.ts"); // rename → new path added
    vi.advanceTimersByTime(100);
    expect(calls.length).toBe(1);
    expect(calls[0].sort()).toEqual(["new.ts", "old.ts"]);
    m.dispose();
  });

  it("a second burst after a flush starts a fresh stale set", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const m = build(lc, fw, async (_r, stale) => {
      calls.push(stale);
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    vi.advanceTimersByTime(100);
    fw.fire("/a", "b.ts");
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["a.ts"], ["b.ts"]]); // no carryover between flushes
    m.dispose();
  });

  it("clears a pending debounce on release — no flush against a closed workspace (P1-H)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const m = build(lc, fw, async (_r, stale) => {
      calls.push(stale);
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts"); // arms debounce
    lc.onSessionClose("/a"); // release before it fires
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([]); // pending flush cancelled
    m.dispose();
  });

  it("surfaces updater errors via onError without throwing", async () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const errors: unknown[] = [];
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 50,
      updateGraph: async () => {
        throw new Error("boom");
      },
      updateLexical: noop,
      updateSemantic: noop,
      onError: (_r, e) => errors.push(e),
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    await vi.advanceTimersByTimeAsync(50); // fire flush + settle the rejected promise
    expect((errors[0] as Error).message).toBe("boom");
    m.dispose();
  });
});

describe("IndexMaintainer — throttled heavy rebuilds + idle prebuild", () => {
  afterEach(() => vi.useRealTimers());

  it("flush triggers a lexical + semantic rebuild alongside the code-graph update", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const lex: string[] = [];
    const sem: string[] = [];
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      bgCooldownMs: 1000,
      updateGraph: noop,
      updateLexical: async (r) => {
        lex.push(r);
      },
      updateSemantic: async (r) => {
        sem.push(r);
      },
      now: () => 1_000_000,
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    vi.advanceTimersByTime(100);
    expect(lex).toEqual(["/a"]);
    expect(sem).toEqual(["/a"]);
    m.dispose();
  });

  it("throttles heavy rebuilds within the cooldown — code-graph still runs every flush", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const graph: string[][] = [];
    const lex: string[] = [];
    let t = 1_000_000;
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      bgCooldownMs: 1000,
      updateGraph: async (_r, stale) => {
        graph.push(stale);
      },
      updateLexical: async (r) => {
        lex.push(r);
      },
      updateSemantic: noop,
      now: () => t,
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    vi.advanceTimersByTime(100); // flush 1: graph + heavy
    t += 500; // still inside cooldown
    fw.fire("/a", "b.ts");
    vi.advanceTimersByTime(100); // flush 2: graph only
    expect(graph).toEqual([["a.ts"], ["b.ts"]]); // graph ran both flushes
    expect(lex).toEqual(["/a"]); // lexical throttled → once
    m.dispose();
  });

  it("re-runs heavy rebuilds after the cooldown elapses", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const lex: string[] = [];
    let t = 1_000_000;
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      bgCooldownMs: 1000,
      updateGraph: noop,
      updateLexical: async (r) => {
        lex.push(r);
      },
      updateSemantic: noop,
      now: () => t,
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    vi.advanceTimersByTime(100); // heavy run 1
    t += 1500; // past cooldown
    fw.fire("/a", "b.ts");
    vi.advanceTimersByTime(100); // heavy run 2
    expect(lex).toEqual(["/a", "/a"]);
    m.dispose();
  });

  it("idle prebuild triggers a throttled heavy rebuild", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle(50); // quietMs=50 → emits idle
    const fw = fakeWatch();
    const lex: string[] = [];
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      bgCooldownMs: 1000,
      updateGraph: noop,
      updateLexical: async (r) => {
        lex.push(r);
      },
      updateSemantic: noop,
      now: () => 1_000_000,
    });
    lc.onSessionOpen("/a"); // arms the quiet timer
    vi.advanceTimersByTime(50); // idle fires → prebuild → maybeHeavy
    expect(lex).toEqual(["/a"]);
    m.dispose();
  });

  it("status() reports each watched root's pending stale + lastHeavy", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const m = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      bgCooldownMs: 1000,
      updateGraph: noop,
      updateLexical: noop,
      updateSemantic: noop,
      now: () => 5000,
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "x.ts"); // queues a stale path
    expect(m.status()).toEqual([{ root: "/a", pendingStale: 1, lastHeavyMs: null }]);
    vi.advanceTimersByTime(100); // flush → heavy runs (lastHeavy=5000), stale cleared
    expect(m.status()).toEqual([{ root: "/a", pendingStale: 0, lastHeavyMs: 5000 }]);
    m.dispose();
  });
});

describe("recursiveWatch — cross-platform recursive directory watch", () => {
  /** Fake per-dir watch primitives backed by an in-memory dir tree. */
  function fakePrims(tree: Record<string, string[]>) {
    const watchers = new Map<string, (name: string | null) => void>();
    const prims: WatchPrimitives = {
      listDirs: (dir) => tree[dir] ?? [],
      watchDir: (dir, onEvent) => {
        watchers.set(dir, onEvent);
        return { close: () => watchers.delete(dir) };
      },
    };
    return {
      prims,
      watchers,
      fire: (dir: string, name: string | null) => watchers.get(dir)?.(name),
    };
  }

  it("watches the root and every subdirectory, closing all on close", () => {
    const f = fakePrims({
      "/r": ["/r/a", "/r/b"],
      "/r/a": ["/r/a/x"],
      "/r/b": [],
      "/r/a/x": [],
    });
    const w = recursiveWatch("/r", () => {}, f.prims);
    expect([...f.watchers.keys()].sort()).toEqual(["/r", "/r/a", "/r/a/x", "/r/b"]);
    w.close();
    expect(f.watchers.size).toBe(0);
  });

  it("picks up a newly-created subdirectory on the next event", () => {
    const tree: Record<string, string[]> = { "/r": [] };
    const f = fakePrims(tree);
    const changes: string[] = [];
    recursiveWatch("/r", (file) => changes.push(file), f.prims);
    expect([...f.watchers.keys()]).toEqual(["/r"]);
    tree["/r"] = ["/r/new"]; // a new subdir appears...
    tree["/r/new"] = [];
    f.fire("/r", "new"); // ...and an event fires in /r
    expect([...f.watchers.keys()].sort()).toEqual(["/r", "/r/new"]);
    expect(changes).toEqual(["new"]); // relative(/r, /r/new) === "new"
  });

  it("listWatchableDirs excludes SKIP_DIR_NAMES and symlinks (NF-106)", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-watch-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
    try {
      symlinkSync(join(root, "src"), join(root, "link"));
    } catch {
      // symlink may be unsupported (Windows w/o privilege) — src/skip assertions still hold.
    }
    const names = listWatchableDirs(root).map((d) => d.slice(root.length + 1));
    expect(names).toContain("src");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("link");
  });
});

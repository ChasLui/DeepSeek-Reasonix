/** IndexMaintainer (Slice 1) — fs-watch → debounce → code-graph incremental, driven by WorkspaceLifecycle. A fake watch + spy updater isolate the logic from the platform/filesystem. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexMaintainer, type WatchFactory } from "../src/daemon/index-maintainer.js";
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

const noopUpdate = async () => {};

describe("IndexMaintainer — watch lifecycle", () => {
  it("starts a watcher when a workspace opens, releases it when it closes", () => {
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      updateGraph: noopUpdate,
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
      updateGraph: noopUpdate,
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
      updateGraph: noopUpdate,
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
      updateGraph: noopUpdate,
    });
    im.dispose();
    lc.onSessionOpen("/a");
    expect(im.watchedRoots()).toEqual([]);
    expect(fw.isWatching("/a")).toBe(false);
  });
});

describe("IndexMaintainer — debounce + incremental", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces a burst into one update with the union of changed paths", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: Array<{ root: string; stale: string[] }> = [];
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      updateGraph: async (root, stale) => {
        calls.push({ root, stale });
      },
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
    im.dispose();
  });

  it("covers a rename's old AND new path — both watch events enter the stale set (P1-F)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      updateGraph: async (_root, stale) => {
        calls.push(stale);
      },
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "old.ts"); // rename → old path removed
    fw.fire("/a", "new.ts"); // rename → new path added
    vi.advanceTimersByTime(100);
    expect(calls.length).toBe(1);
    expect(calls[0].sort()).toEqual(["new.ts", "old.ts"]);
    im.dispose();
  });

  it("a second burst after a flush starts a fresh stale set", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      updateGraph: async (_r, stale) => {
        calls.push(stale);
      },
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    vi.advanceTimersByTime(100);
    fw.fire("/a", "b.ts");
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["a.ts"], ["b.ts"]]); // no carryover between flushes
    im.dispose();
  });

  it("clears a pending debounce on release — no flush against a closed workspace (P1-H)", () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const calls: string[][] = [];
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 100,
      updateGraph: async (_r, stale) => {
        calls.push(stale);
      },
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts"); // arms debounce
    lc.onSessionClose("/a"); // release before it fires
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([]); // pending flush cancelled
    im.dispose();
  });

  it("surfaces updater errors via onError without throwing", async () => {
    vi.useFakeTimers();
    const lc = new WorkspaceLifecycle();
    const fw = fakeWatch();
    const errors: unknown[] = [];
    const im = new IndexMaintainer(lc, {
      watch: fw.factory,
      debounceMs: 50,
      updateGraph: async () => {
        throw new Error("boom");
      },
      onError: (_r, e) => errors.push(e),
    });
    lc.onSessionOpen("/a");
    fw.fire("/a", "a.ts");
    await vi.advanceTimersByTimeAsync(50); // fire flush + settle the rejected promise
    expect((errors[0] as Error).message).toBe("boom");
    im.dispose();
  });
});

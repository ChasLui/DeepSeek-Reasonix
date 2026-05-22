import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME,
  applyCompactor,
  getCompactionStats,
  registerCompactor,
  resetCompactionStats,
  resetCompactors,
  selectCompactor,
  unregisterCompactor,
} from "../../src/compact/registry.js";

const runtime = DEFAULT_RUNTIME;

beforeEach(() => {
  resetCompactors();
});
afterEach(() => {
  resetCompactors();
});

describe("compactor registry", () => {
  it("dispatches to the first matching filter", () => {
    registerCompactor({
      id: "first",
      match: (argv) => argv[0] === "git",
      filter: () => "FIRST",
    });
    registerCompactor({
      id: "second",
      match: (argv) => argv[0] === "git",
      filter: () => "SECOND",
    });
    const r = applyCompactor("git status", "raw output", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toBe("FIRST");
    expect(r.filter).toBe("first");
  });

  it("falls through when no filter matches", () => {
    registerCompactor({
      id: "git-only",
      match: (argv) => argv[0] === "git",
      filter: () => "X",
    });
    const r = applyCompactor("ls -la", "long output", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toBe("long output");
    expect(r.filter).toBe("passthrough");
    expect(r.savedBytes).toBe(0);
  });

  it("returns raw and records 'fallback' when filter throws", () => {
    registerCompactor({
      id: "buggy",
      match: () => true,
      filter: () => {
        throw new Error("boom");
      },
    });
    const r = applyCompactor("anything", "raw text", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toBe("raw text");
    expect(r.filter).toBe("fallback");
    expect(getCompactionStats().get("fallback")?.hits).toBe(1);
  });

  it("treats filter returning null as passthrough", () => {
    registerCompactor({
      id: "abstainer",
      match: () => true,
      filter: () => null,
    });
    const r = applyCompactor("foo bar", "raw", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toBe("raw");
    expect(r.filter).toBe("passthrough");
  });

  it("DISABLED runtime short-circuits", () => {
    registerCompactor({
      id: "always",
      match: () => true,
      filter: () => "compact",
    });
    const r = applyCompactor("foo", "raw", {
      exitCode: 0,
      timedOut: false,
      runtime: { enabled: false, exclude: new Set() },
    });
    expect(r.compact).toBe("raw");
    expect(r.filter).toBe("disabled");
  });

  it("exclude skips matching argv[0]", () => {
    registerCompactor({
      id: "git-x",
      match: (argv) => argv[0] === "git",
      filter: () => "compact-git",
    });
    const r = applyCompactor("git status", "raw status", {
      exitCode: 0,
      timedOut: false,
      runtime: { enabled: true, exclude: new Set(["git"]) },
    });
    expect(r.compact).toBe("raw status");
    expect(r.filter).toBe("passthrough");
  });

  it("counts hits and savedBytes per filter id", () => {
    resetCompactionStats();
    registerCompactor({
      id: "shrinker",
      match: (argv) => argv[0] === "foo",
      filter: () => "tiny",
    });
    applyCompactor("foo a", "a very long string of raw output", {
      exitCode: 0,
      timedOut: false,
    });
    applyCompactor("foo b", "another long string", {
      exitCode: 0,
      timedOut: false,
    });
    const entry = getCompactionStats().get("shrinker");
    expect(entry?.hits).toBe(2);
    expect(entry?.savedBytes).toBeGreaterThan(0);
  });

  it("refuses duplicate registration of the same id", () => {
    registerCompactor({ id: "dup", match: () => false, filter: () => null });
    expect(() => {
      registerCompactor({ id: "dup", match: () => false, filter: () => null });
    }).toThrow(/already registered/);
  });

  it("unregister returns false for unknown id, true for known", () => {
    registerCompactor({ id: "known", match: () => false, filter: () => null });
    expect(unregisterCompactor("missing")).toBe(false);
    expect(unregisterCompactor("known")).toBe(true);
    expect(unregisterCompactor("known")).toBe(false);
  });

  it("treats compact === raw as passthrough", () => {
    registerCompactor({
      id: "no-op",
      match: () => true,
      filter: (input) => input.output,
    });
    const r = applyCompactor("any cmd", "untouched", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
    expect(r.savedBytes).toBe(0);
  });

  it("selectCompactor returns null when registry is empty", () => {
    expect(selectCompactor("foo", ["foo"], runtime)).toBeNull();
  });
});

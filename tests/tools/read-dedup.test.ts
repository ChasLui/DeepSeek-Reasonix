/** ReadDedupState — instance isolation, content-hash judgement, concurrency, log-awareness. */

import { describe, expect, it } from "vitest";
import {
  type EmittedView,
  type FileIdentity,
  ReadDedupState,
  dedupKey,
  emittedViewSignature,
  hashContent,
} from "../../src/tools/fs/read-dedup.js";

const ID: FileIdentity = { dev: 1, ino: 42, size: 100, mtimeMs: 1000 };
const ABS = "/x/a.txt";
const VIEW: EmittedView = {
  mode: "full",
  aggressive: false,
  outlineThreshold: 65536,
};
const SIG = emittedViewSignature(VIEW);
const KEY = dedupKey(ABS, SIG);
const HASH = hashContent(Buffer.from("hello world"));

function freshHit(state: ReadDedupState): void {
  // record then make the token live → a subsequent lookup hits
  state.record(KEY, ID, HASH, 10, 100);
}

describe("emittedViewSignature", () => {
  it("is deterministic and order-fixed", () => {
    expect(emittedViewSignature(VIEW)).toBe(emittedViewSignature({ ...VIEW }));
  });
  it("distinguishes modes and scopes", () => {
    expect(emittedViewSignature({ ...VIEW, mode: "head", head: 5 })).not.toBe(
      emittedViewSignature({ ...VIEW, mode: "tail", tail: 5 }),
    );
    expect(emittedViewSignature({ ...VIEW, aggressive: true })).not.toBe(SIG);
    expect(emittedViewSignature({ ...VIEW, outlineThreshold: 1 })).not.toBe(SIG);
  });
});

describe("dedupKey binds to path + view", () => {
  it("same path+view → same key; different path or view → different key", () => {
    expect(dedupKey(ABS, SIG)).toBe(dedupKey(ABS, SIG));
    expect(dedupKey("/x/b.txt", SIG)).not.toBe(KEY); // alias/hardlink → distinct key
    expect(dedupKey(ABS, emittedViewSignature({ ...VIEW, mode: "head", head: 5 }))).not.toBe(KEY);
  });
});

describe("lookup — three-part hit condition", () => {
  it("misses when nothing recorded", () => {
    const s = new ReadDedupState();
    expect(s.lookup(KEY, ID, HASH)).toBeNull();
  });

  it("hits when identity + hash + liveness all match", () => {
    const s = new ReadDedupState();
    freshHit(s);
    const e = s.lookup(KEY, ID, HASH);
    expect(e).not.toBeNull();
    expect(e?.lines).toBe(10);
  });

  it("misses on hash mismatch (same size/mtime, different content)", () => {
    const s = new ReadDedupState();
    freshHit(s);
    const otherHash = hashContent(Buffer.from("HELLO WORLD")); // same length, diff bytes
    expect(s.lookup(KEY, ID, otherHash)).toBeNull();
  });

  it("misses on identity drift (mtime / size / inode)", () => {
    const s = new ReadDedupState();
    freshHit(s);
    expect(s.lookup(KEY, { ...ID, mtimeMs: 2000 }, HASH)).toBeNull();
    expect(s.lookup(KEY, { ...ID, size: 101 }, HASH)).toBeNull();
    expect(s.lookup(KEY, { ...ID, ino: 7 }, HASH)).toBeNull();
  });

  it("misses after compaction drops the prior output (invalidateAll)", () => {
    const s = new ReadDedupState();
    freshHit(s);
    expect(s.lookup(KEY, ID, HASH)).not.toBeNull();
    s.invalidateAll();
    expect(s.lookup(KEY, ID, HASH)).toBeNull();
  });
});

describe("beginRead — concurrency determinism", () => {
  it("forces a miss while a key is in flight", () => {
    const s = new ReadDedupState();
    expect(s.beginRead(KEY)).toBe(true); // first owns the key
    expect(s.beginRead(KEY)).toBe(false); // concurrent caller must miss
    s.endRead(KEY);
    expect(s.beginRead(KEY)).toBe(true); // freed
  });
});

describe("instance isolation", () => {
  it("two states do not share entries (multi-session safety)", () => {
    const a = new ReadDedupState();
    const b = new ReadDedupState();
    freshHit(a);
    expect(a.lookup(KEY, ID, HASH)).not.toBeNull();
    expect(b.lookup(KEY, ID, HASH)).toBeNull(); // session B never saw it
  });

  it("reset clears only its own instance", () => {
    const a = new ReadDedupState();
    const b = new ReadDedupState();
    freshHit(a);
    freshHit(b);
    a.reset();
    expect(a.lookup(KEY, ID, HASH)).toBeNull();
    expect(b.lookup(KEY, ID, HASH)).not.toBeNull();
  });
});

describe("stats", () => {
  it("tracks hits / dumpsSaved / bytesSaved", () => {
    const s = new ReadDedupState();
    s.markHit(100);
    s.markHit(50);
    expect(s.getStats()).toEqual({ hits: 2, dumpsSaved: 2, bytesSaved: 150 });
    s.reset();
    expect(s.getStats()).toEqual({ hits: 0, dumpsSaved: 0, bytesSaved: 0 });
  });
});

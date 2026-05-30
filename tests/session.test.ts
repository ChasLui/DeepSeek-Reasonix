import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  appendSessionMessage,
  archiveSession,
  deleteSession,
  findSessionsByPrefix,
  freshSessionName,
  listSessions,
  listSessionsForWorkspace,
  loadSessionMessages,
  normalizeWorkspace,
  patchSessionMeta,
  pruneStaleSessions,
  renameSession,
  resolveSession,
  rewriteSession,
  sanitizeName,
  sessionPath,
  timestampSuffix,
} from "../src/memory/session.js";
import { getDb, resetDb } from "../src/storage/db.js";
import { upsertSessionMeta } from "../src/storage/sessions-repo.js";

describe("sanitizeName", () => {
  it("keeps alphanumerics, CJK, dashes, underscores", () => {
    expect(sanitizeName("hello-world_1")).toBe("hello-world_1");
    expect(sanitizeName("我的对话")).toBe("我的对话");
  });
  it("replaces other characters with underscore", () => {
    expect(sanitizeName("my/path:bad?")).toBe("my_path_bad_");
  });
  it("caps at 64 chars and defaults to 'default' when empty", () => {
    expect(sanitizeName("")).toBe("default");
    expect(sanitizeName("/:@!").length).toBeLessThanOrEqual(4);
    expect(sanitizeName("a".repeat(200))).toHaveLength(64);
  });
});

// Backdate a session's mtime by writing an explicit updated_at on its meta row —
// the SQLite analog of utimesSync on the old jsonl. listSessions/pruneStale read
// mtime from sessions.updated_at.
function backdateSession(name: string, when: Date): void {
  upsertSessionMeta(getDb(), sanitizeName(name), {}, when.toISOString());
}

describe("session persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-session-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    // os.homedir() is cached per-process on some platforms — override via spy.
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
    // Re-open the singleton DB under the freshly-homed tmp dir.
    resetDb();
  });

  afterEach(() => {
    resetDb();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("sessionPath lives under <home>/.reasonix/sessions", () => {
    const p = sessionPath("demo");
    expect(p).toContain(".reasonix");
    expect(p).toContain("sessions");
    expect(p.endsWith("demo.jsonl")).toBe(true);
    expect(p.startsWith(tmp)).toBe(true);
  });

  it("loadSessionMessages returns [] when the session has no rows", () => {
    expect(loadSessionMessages("ghost")).toEqual([]);
  });

  it("appendSessionMessage + loadSessionMessages round-trip", () => {
    appendSessionMessage("foo", { role: "user", content: "hi" });
    appendSessionMessage("foo", { role: "assistant", content: "hello" });
    const msgs = loadSessionMessages("foo");
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("rewriteSession replaces the live log", () => {
    appendSessionMessage("safe-rewrite", { role: "user", content: "old" });
    rewriteSession("safe-rewrite", [{ role: "user", content: "new" }]);
    expect(loadSessionMessages("safe-rewrite")).toEqual([{ role: "user", content: "new" }]);
  });

  it("listSessions returns metadata sorted by mtime desc", () => {
    appendSessionMessage("alpha", { role: "user", content: "x" });
    appendSessionMessage("beta", { role: "user", content: "y" });
    appendSessionMessage("beta", { role: "user", content: "z" });
    const items = listSessions();
    expect(items.length).toBe(2);
    const names = items.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    const beta = items.find((s) => s.name === "beta")!;
    expect(beta.messageCount).toBe(2);
  });

  it("listSessionsForWorkspace matches meta.workspace and hides untagged sessions", () => {
    appendSessionMessage("here", { role: "user", content: "x" });
    appendSessionMessage("there", { role: "user", content: "x" });
    appendSessionMessage("untagged", { role: "user", content: "x" });
    patchSessionMeta("here", { workspace: "/proj/a" });
    patchSessionMeta("there", { workspace: "/proj/b" });
    const names = listSessionsForWorkspace("/proj/a").map((s) => s.name);
    expect(names).toEqual(["here"]);
  });

  it("listSessionsForWorkspace tolerates trailing-slash drift", () => {
    appendSessionMessage("a", { role: "user", content: "x" });
    patchSessionMeta("a", { workspace: "/proj/a/" });
    const names = listSessionsForWorkspace("/proj/a").map((s) => s.name);
    expect(names).toEqual(["a"]);
  });

  it("listSessionsForWorkspace preserves messageCount for matched sessions (issue #1179)", () => {
    // Workspace pre-filter must not strip the metadata downstream consumers rely on.
    appendSessionMessage("here", { role: "user", content: "hello" });
    appendSessionMessage("here", { role: "assistant", content: "world" });
    appendSessionMessage("elsewhere", { role: "user", content: "skip" });
    patchSessionMeta("here", { workspace: "/proj/a" });
    patchSessionMeta("elsewhere", { workspace: "/proj/b" });
    const matched = listSessionsForWorkspace("/proj/a");
    expect(matched.map((s) => s.name)).toEqual(["here"]);
    expect(matched[0]!.messageCount).toBe(2);
    expect(matched[0]!.meta.workspace).toBe("/proj/a");
  });

  it("renameSession moves the conversation log to the new name, zero orphans", () => {
    appendSessionMessage("orig", { role: "user", content: "x" });
    expect(renameSession("orig", "renamed")).toBe(true);
    expect(loadSessionMessages("orig")).toEqual([]);
    expect(loadSessionMessages("renamed")).toEqual([{ role: "user", content: "x" }]);
  });

  it("renameSession returns false on a collision with an existing session", () => {
    appendSessionMessage("from", { role: "user", content: "x" });
    appendSessionMessage("to", { role: "user", content: "y" });
    expect(renameSession("from", "to")).toBe(false);
    expect(loadSessionMessages("from")).toEqual([{ role: "user", content: "x" }]);
    expect(loadSessionMessages("to")).toEqual([{ role: "user", content: "y" }]);
  });

  it("pruneStaleSessions deletes sessions older than the cutoff and leaves fresh ones", () => {
    appendSessionMessage("ancient1", { role: "user", content: "x" });
    appendSessionMessage("ancient2", { role: "user", content: "x" });
    appendSessionMessage("recent", { role: "user", content: "x" });
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    backdateSession("ancient1", oldDate);
    backdateSession("ancient2", oldDate);
    backdateSession("recent", new Date());

    const removed = pruneStaleSessions(90);
    expect(removed.sort()).toEqual(["ancient1", "ancient2"]);
    expect(loadSessionMessages("ancient1")).toEqual([]);
    expect(loadSessionMessages("ancient2")).toEqual([]);
    expect(loadSessionMessages("recent")).toEqual([{ role: "user", content: "x" }]);
  });

  it("pruneStaleSessions with a tighter cutoff catches sessions the default would skip", () => {
    appendSessionMessage("yesterday", { role: "user", content: "x" });
    const yest = new Date(Date.now() - 36 * 60 * 60 * 1000); // 1.5 days
    backdateSession("yesterday", yest);

    expect(pruneStaleSessions(90)).toEqual([]);
    expect(loadSessionMessages("yesterday")).toEqual([{ role: "user", content: "x" }]);
    expect(pruneStaleSessions(1)).toEqual(["yesterday"]);
    expect(loadSessionMessages("yesterday")).toEqual([]);
  });

  describe("archiveSession", () => {
    it("returns null when the session has no messages", () => {
      expect(archiveSession("ghost")).toBeNull();
    });

    it("renames the live log to a timestamped archive name, source goes empty", () => {
      appendSessionMessage("live", { role: "user", content: "hi" });
      patchSessionMeta("live", { branch: "main" });

      const archived = archiveSession("live");
      expect(archived).toMatch(/^live__archive_\d{12}/);
      expect(loadSessionMessages("live")).toEqual([]);
      expect(loadSessionMessages(archived!)).toEqual([{ role: "user", content: "hi" }]);
      expect(listSessions().find((s) => s.name === archived)?.meta.branch).toBe("main");
    });

    it("disambiguates when called twice in the same minute", () => {
      appendSessionMessage("rapid", { role: "user", content: "first" });
      const a = archiveSession("rapid");
      appendSessionMessage("rapid", { role: "user", content: "second" });
      const b = archiveSession("rapid");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
      expect(loadSessionMessages(a!)).toEqual([{ role: "user", content: "first" }]);
      expect(loadSessionMessages(b!)).toEqual([{ role: "user", content: "second" }]);
    });

    it("archive name is excluded from the resume-by-prefix lookup", () => {
      appendSessionMessage("proj", { role: "user", content: "x" });
      const archived = archiveSession("proj");
      expect(archived).not.toBeNull();
      expect(findSessionsByPrefix("proj-")).toEqual([]);
    });

    it("archive shows up in listSessions", () => {
      appendSessionMessage("show", { role: "user", content: "x" });
      const archived = archiveSession("show");
      const names = listSessions().map((s) => s.name);
      expect(names).toContain(archived);
    });
  });

  describe("clearLog archive integration", () => {
    it("CacheFirstLoop.clearLog archives the live transcript and starts an empty log", () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: (async () => new Response()) as any,
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        session: "clear-archive",
      });
      loop.appendAndPersist({ role: "user", content: "first turn" });
      loop.appendAndPersist({ role: "assistant", content: "reply" });

      const { dropped, archived } = loop.clearLog();
      expect(dropped).toBe(2);
      expect(archived).toMatch(/^clear-archive__archive_\d{12}/);
      expect(loadSessionMessages(archived!)).toHaveLength(2);
      expect(loadSessionMessages("clear-archive")).toEqual([]);
      expect(loop.log.length).toBe(0);
    });

    it("clearLog returns archived: null when the session has nothing to archive", () => {
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        fetch: (async () => new Response()) as any,
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        session: "clear-empty",
      });
      const { archived } = loop.clearLog();
      expect(archived).toBeNull();
    });
  });

  it("deleteSession purges the conversation log", () => {
    appendSessionMessage("gone", { role: "user", content: "x" });
    expect(loadSessionMessages("gone")).toHaveLength(1);
    expect(deleteSession("gone")).toBe(true);
    expect(loadSessionMessages("gone")).toEqual([]);
  });

  it("loop.appendAndPersist writes bang-style messages to the session log", () => {
    // Regression: before 0.5.14 the bang handler called loop.log.append which
    // only touched memory, so `!cmd` output was lost on session resume.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: (async () => new Response()) as any,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: "bang-persist",
    });
    loop.appendAndPersist({
      role: "user",
      content: "[!ls]\n$ ls\n[exit 0]\nfile1 file2",
    });
    const reloaded = loadSessionMessages("bang-persist");
    expect(reloaded).toEqual([{ role: "user", content: "[!ls]\n$ ls\n[exit 0]\nfile1 file2" }]);
  });

  describe("timestampSuffix", () => {
    it("returns a 12-character string of digits", () => {
      const ts = timestampSuffix();
      expect(ts).toMatch(/^\d{12}$/);
    });

    it("starts with the current year", () => {
      const year = String(new Date().getFullYear());
      expect(timestampSuffix().startsWith(year)).toBe(true);
    });

    it("is sortable — later calls produce lexicographically larger strings", () => {
      const a = timestampSuffix();
      const b = timestampSuffix();
      // In the unlikely event both fall on the same minute, they're equal
      expect(b.localeCompare(a)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("freshSessionName", () => {
    it("defaults to a default-prefixed name when no current session", () => {
      expect(freshSessionName(undefined)).toMatch(/^default-\d{14}$/);
    });

    it("preserves a non-timestamped base", () => {
      expect(freshSessionName("foo")).toMatch(/^foo-\d{14}$/);
    });

    it("strips an existing 12-digit timestamp suffix before re-stamping", () => {
      expect(freshSessionName("foo-202605120800")).toMatch(/^foo-\d{14}$/);
    });

    it("strips an existing 14-digit timestamp suffix before re-stamping", () => {
      expect(freshSessionName("foo-20260512080000")).toMatch(/^foo-\d{14}$/);
    });

    it("keeps dashed bases intact (only the trailing timestamp is stripped)", () => {
      expect(freshSessionName("my-app-bar")).toMatch(/^my-app-bar-\d{14}$/);
    });
  });

  describe("resolveSession", () => {
    it("returns the base name when no prior sessions and no flags", () => {
      const { resolved, preview } = resolveSession("fresh");
      expect(resolved).toBe("fresh");
      expect(preview).toBeUndefined();
    });

    it("generates a timestamped name on forceNew", () => {
      const { resolved, preview } = resolveSession("demo", true);
      expect(resolved).toMatch(/^demo-\d{12}$/);
      expect(preview).toBeUndefined();
    });

    it("returns undefined when sessionName is undefined", () => {
      const { resolved, preview } = resolveSession(undefined);
      expect(resolved).toBeUndefined();
      expect(preview).toBeUndefined();
    });

    it("picks the base name when no prefixed sessions exist and it has messages", () => {
      appendSessionMessage("project", { role: "user", content: "hello" });
      const { resolved, preview } = resolveSession("project");
      expect(resolved).toBe("project");
      expect(preview).toBeDefined();
      expect(preview!.messageCount).toBe(1);
    });

    it("ignores timestamped names that have no conversation-log rows", () => {
      appendSessionMessage("myproject", {
        role: "user",
        content: "real messages",
      });
      // A meta-only sibling (no messages) must not be picked over the base.
      patchSessionMeta("myproject-20260430T200000", { branch: "x" });

      const { resolved, preview } = resolveSession("myproject");
      expect(resolved).toBe("myproject");
      expect(preview).toBeDefined();
      expect(preview!.messageCount).toBe(1);
    });

    it("picks the latest prefixed session over the base name", () => {
      appendSessionMessage("project", { role: "user", content: "old" });
      appendSessionMessage("project-20260430T091500", {
        role: "user",
        content: "newer",
      });
      appendSessionMessage("project-20260430T154500", {
        role: "user",
        content: "newest",
      });

      const { resolved, preview } = resolveSession("project");
      // Bare "project" is excluded — prefix lookup uses "project-" (with dash),
      // newest-first by name sort.
      expect(resolved).toBe("project-20260430T154500");
      expect(preview).toBeDefined();
    });

    it("forceResume resolves to the latest prefixed session", () => {
      appendSessionMessage("app", { role: "user", content: "a" });
      appendSessionMessage("app-20260430T091500", {
        role: "user",
        content: "b",
      });
      const { resolved, preview } = resolveSession("app", false, true);
      expect(resolved).toBe("app-20260430T091500");
      expect(preview).toBeUndefined();
    });

    it("forceResume falls back to base name when no prefixed sessions exist", () => {
      const { resolved, preview } = resolveSession("standalone", false, true);
      expect(resolved).toBe("standalone");
      expect(preview).toBeUndefined();
    });
  });

  describe("findSessionsByPrefix", () => {
    it("returns [] when no sessions exist", () => {
      expect(findSessionsByPrefix("anything")).toEqual([]);
    });

    it("returns session names matching the prefix, sorted alpha-reverse", () => {
      // Name sort — zero-padded YYYYMMDDHHmm sorts newest-first after reverse.
      // Non-digit suffixes (letters > digits in ASCII) sort above timestamps.
      appendSessionMessage("code-reasonix-old", { role: "user", content: "x" });
      appendSessionMessage("code-reasonix-20260430T143200", {
        role: "user",
        content: "y",
      });
      appendSessionMessage("code-reasonix-20260430T154500", {
        role: "user",
        content: "z",
      });

      const result = findSessionsByPrefix("code-reasonix-");
      expect(result).toEqual([
        "code-reasonix-old",
        "code-reasonix-20260430T154500",
        "code-reasonix-20260430T143200",
      ]);
    });

    it("does not return sessions that don't start with the prefix", () => {
      appendSessionMessage("foo-bar", { role: "user", content: "a" });
      appendSessionMessage("foo-baz", { role: "user", content: "b" });
      appendSessionMessage("other-thing", { role: "user", content: "c" });

      expect(findSessionsByPrefix("foo-")).toEqual(["foo-baz", "foo-bar"]);
    });

    it("prefix with trailing dash excludes the bare base session name", () => {
      appendSessionMessage("project", { role: "user", content: "a" });
      appendSessionMessage("project-20260430T143200", {
        role: "user",
        content: "b",
      });

      expect(findSessionsByPrefix("project-")).toEqual(["project-20260430T143200"]);
      // No-dash prefix matches both; name reverse-sort puts the longer name first
      // ("project" < "project-..." so reverse yields the timestamped name first).
      expect(findSessionsByPrefix("project")).toEqual(["project-20260430T143200", "project"]);
    });
  });

  describe("issue #333 — resume seeds cost carryover from session meta", () => {
    it("CacheFirstLoop on resume preloads totalCostUsd / turnCount into stats", () => {
      appendSessionMessage("c333", { role: "user", content: "hi" });
      appendSessionMessage("c333", { role: "assistant", content: "hello" });
      patchSessionMeta("c333", { totalCostUsd: 0.0123, turnCount: 5 });

      const client = new DeepSeekClient({ apiKey: "sk-test" });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "test" }),
        session: "c333",
      });

      expect(loop.stats.totalCost).toBe(0.0123);
      const summary = loop.stats.summary();
      expect(summary.totalCostUsd).toBe(0.0123);
      expect(summary.turns).toBe(5);
    });

    it("fresh session (no meta) leaves carryover at zero", () => {
      const client = new DeepSeekClient({ apiKey: "sk-test" });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "test" }),
        session: "fresh-c333",
      });
      expect(loop.stats.totalCost).toBe(0);
      expect(loop.stats.summary().turns).toBe(0);
    });
  });

  describe("issue #364 — resume seeds cache + lastPromptTokens from session meta", () => {
    it("CacheFirstLoop on resume preloads cache totals + last prompt tokens", () => {
      appendSessionMessage("c364", { role: "user", content: "hi" });
      appendSessionMessage("c364", { role: "assistant", content: "hello" });
      patchSessionMeta("c364", {
        cacheHitTokens: 366976,
        cacheMissTokens: 109,
        lastPromptTokens: 367085,
      });

      const client = new DeepSeekClient({ apiKey: "sk-test" });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "test" }),
        session: "c364",
      });

      const summary = loop.stats.summary();
      expect(summary.cacheHitRatio).toBeCloseTo(366976 / (366976 + 109), 4);
      expect(summary.lastPromptTokens).toBe(367085);
    });
  });
});

describe("normalizeWorkspace", () => {
  it("collapses trailing slashes and `.` segments on posix", () => {
    expect(normalizeWorkspace("/proj/a/", "linux")).toBe("/proj/a");
    expect(normalizeWorkspace("/proj/./a", "linux")).toBe("/proj/a");
  });

  it("lowercases drive letter and unifies separators on win32", () => {
    expect(normalizeWorkspace("C:\\Users\\Foo\\proj", "win32")).toBe("c:/Users/Foo/proj");
    expect(normalizeWorkspace("c:/users/foo/proj", "win32")).toBe("c:/users/foo/proj");
  });

  it("yields the same canonical form for win32 drive-case + separator variants", () => {
    const variants = [
      "C:\\Users\\foo\\proj",
      "c:\\Users\\foo\\proj",
      "C:/Users/foo/proj",
      "c:/Users/foo/proj/",
    ];
    const canonicals = variants.map((v) => normalizeWorkspace(v, "win32"));
    for (const c of canonicals) expect(c).toBe(canonicals[0]);
  });

  it("returns empty string for undefined or empty input", () => {
    expect(normalizeWorkspace(undefined)).toBe("");
    expect(normalizeWorkspace("")).toBe("");
  });
});

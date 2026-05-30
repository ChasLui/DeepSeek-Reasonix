/** SQLite memory store + prefix-loading composer — temp homeDir + isolated db per test. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProjectMemory } from "../src/memory/project.js";
import {
  MEMORY_INDEX_MAX_CHARS,
  applyGlobalReasonixMemory,
  applyMemoryStack,
  applyUserMemory,
  openMemoryStore,
  projectHash,
  sanitizeMemoryName,
} from "../src/memory/user.js";
import { resetDb } from "../src/storage/db.js";

const BASE = "You are a test assistant.";

describe("user-memory", () => {
  let home: string;
  let projectRoot: string;
  const originalEnv = process.env.REASONIX_MEMORY;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-umem-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-umem-proj-"));
    // SQLite-only: openMemoryStore + applyUserMemory resolve getDb() from $HOME.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // biome-ignore lint/performance/noDelete: avoid leaking "undefined" into env
    delete process.env.REASONIX_MEMORY;
  });

  afterEach(() => {
    resetDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: same
      delete process.env.REASONIX_MEMORY;
    } else {
      process.env.REASONIX_MEMORY = originalEnv;
    }
    if (originalHome === undefined) {
      // biome-ignore lint/performance/noDelete: env restoration needs absence, not "undefined"
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      // biome-ignore lint/performance/noDelete: env restoration needs absence, not "undefined"
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  describe("sanitizeMemoryName", () => {
    it("accepts simple identifiers", () => {
      expect(sanitizeMemoryName("foo_bar")).toBe("foo_bar");
      expect(sanitizeMemoryName("abc-def.9")).toBe("abc-def.9");
      expect(sanitizeMemoryName("  padded  ")).toBe("padded");
    });
    it("rejects path-separator injection", () => {
      expect(() => sanitizeMemoryName("../etc/passwd")).toThrow(/invalid memory name/);
      expect(() => sanitizeMemoryName("foo/bar")).toThrow();
      expect(() => sanitizeMemoryName("foo\\bar")).toThrow();
    });
    it("rejects leading dot / too-short / too-long names", () => {
      expect(() => sanitizeMemoryName(".hidden")).toThrow();
      expect(() => sanitizeMemoryName("ab")).toThrow();
      expect(() => sanitizeMemoryName("a".repeat(41))).toThrow();
    });
  });

  describe("projectHash", () => {
    it("returns a stable 16-hex-char digest for the same path", () => {
      const a = projectHash("/tmp/whatever");
      const b = projectHash("/tmp/whatever");
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
    it("differs across paths", () => {
      expect(projectHash("/tmp/a")).not.toBe(projectHash("/tmp/b"));
    });
  });

  describe("SqliteMemoryStore basic I/O", () => {
    it("writes a global memory and surfaces it in the index", () => {
      const store = openMemoryStore({ homeDir: home });
      store.write({
        name: "snake_case",
        type: "feedback",
        scope: "global",
        description: "User prefers snake_case for new Python modules",
        body: "Rule.\n\n**Why:** PEP 8.\n\n**How to apply:** new .py files default to snake_case.",
      });
      // No markdown file on disk — exportMarkdown materializes the same frontmatter + body.
      const md = store.exportMarkdown("global", "snake_case") ?? "";
      expect(md).toMatch(/^---\nname: snake_case\n/);
      expect(md).toContain("Rule.");
      const idx = store.loadIndex("global");
      expect(idx?.content).toContain("[snake_case](snake_case.md)");
      expect(idx?.content).toContain("User prefers snake_case");
    });

    it("round-trips write → read → list → delete for global scope", () => {
      const store = openMemoryStore({ homeDir: home });
      store.write({
        name: "one",
        type: "user",
        scope: "global",
        description: "First memory",
        body: "content one",
      });
      store.write({
        name: "two",
        type: "reference",
        scope: "global",
        description: "Second memory",
        body: "content two",
      });
      const listed = store.list();
      expect(listed.map((e) => e.name).sort()).toEqual(["one", "two"]);

      const one = store.read("global", "one");
      expect(one.body).toBe("content one");
      expect(one.type).toBe("user");
      expect(one.description).toBe("First memory");
      expect(one.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const removed = store.delete("global", "one");
      expect(removed).toBe(true);
      expect(store.list().map((e) => e.name)).toEqual(["two"]);

      // The index should no longer reference "one".
      const idx = store.loadIndex("global");
      expect(idx?.content).not.toContain("one.md");
      expect(idx?.content).toContain("two.md");
    });

    it("returns false when deleting a nonexistent memory", () => {
      const store = openMemoryStore({ homeDir: home });
      expect(store.delete("global", "ghost")).toBe(false);
    });

    it("loadIndex returns null after the last memory is deleted", () => {
      const store = openMemoryStore({ homeDir: home });
      store.write({
        name: "only",
        type: "project",
        scope: "global",
        description: "d",
        body: "b",
      });
      store.delete("global", "only");
      expect(store.loadIndex("global")).toBeNull();
    });

    it("refuses project scope without a projectRoot", () => {
      const store = openMemoryStore({ homeDir: home });
      expect(store.hasProjectScope()).toBe(false);
      expect(() =>
        store.write({
          name: "nope",
          type: "project",
          scope: "project",
          description: "d",
          body: "b",
        }),
      ).toThrow(/projectRoot/);
    });

    it("isolates project scope from global scope via the PK", () => {
      const store = openMemoryStore({ homeDir: home, projectRoot });
      expect(store.hasProjectScope()).toBe(true);
      store.write({
        name: "bun_build",
        type: "project",
        scope: "project",
        description: "Build command is `bun run build` on this machine",
        body: "Body here.",
      });
      expect(store.query("project", "bun_build")?.body).toBe("Body here.");
      // Global scope must NOT see the project-scoped row.
      expect(store.query("global", "bun_build")).toBeNull();
    });

    it("validates description / body non-empty", () => {
      const store = openMemoryStore({ homeDir: home });
      expect(() =>
        store.write({
          name: "x_y_z",
          type: "user",
          scope: "global",
          description: "",
          body: "b",
        }),
      ).toThrow(/description/);
      expect(() =>
        store.write({
          name: "x_y_z",
          type: "user",
          scope: "global",
          description: "d",
          body: " \n",
        }),
      ).toThrow(/body/);
    });

    it("loadIndex returns null for absent scope, content + flag for present", () => {
      const store = openMemoryStore({ homeDir: home });
      expect(store.loadIndex("global")).toBeNull();
      store.write({
        name: "x_y_z",
        type: "user",
        scope: "global",
        description: "hi",
        body: "b",
      });
      const idx = store.loadIndex("global");
      expect(idx).not.toBeNull();
      expect(idx?.truncated).toBe(false);
      expect(idx?.content).toContain("x_y_z");
    });

    it("loadIndex truncates with a visible marker past the cap", () => {
      const store = openMemoryStore({ homeDir: home });
      // Write many entries so the index crosses the cap.
      for (let i = 0; i < 80; i++) {
        store.write({
          name: `entry_${String(i).padStart(3, "0")}`,
          type: "user",
          scope: "global",
          description: "x".repeat(120),
          body: "b",
        });
      }
      const idx = store.loadIndex("global");
      expect(idx?.truncated).toBe(true);
      expect(idx?.content).toMatch(/truncated \d+ chars/);
      expect((idx?.content.length ?? 0) < MEMORY_INDEX_MAX_CHARS + 64).toBe(true);
    });

    it("index is byte-stable for identical row sets regardless of insert order (cache-prefix safety)", () => {
      const store = openMemoryStore({ homeDir: home });
      store.write({
        name: "a_one",
        type: "user",
        scope: "global",
        description: "d1",
        body: "b1",
      });
      store.write({
        name: "b_two",
        type: "user",
        scope: "global",
        description: "d2",
        body: "b2",
      });
      const first = store.loadIndex("global");
      // Delete + re-write in reverse order — sorted index should match.
      store.delete("global", "a_one");
      store.delete("global", "b_two");
      store.write({
        name: "b_two",
        type: "user",
        scope: "global",
        description: "d2",
        body: "b2",
      });
      store.write({
        name: "a_one",
        type: "user",
        scope: "global",
        description: "d1",
        body: "b1",
      });
      expect(store.loadIndex("global")).toEqual(first);
    });
  });

  describe("applyUserMemory", () => {
    it("is a no-op when both scopes are empty", () => {
      expect(applyUserMemory(BASE, { homeDir: home, projectRoot })).toBe(BASE);
    });

    it("appends only global summaries when no project memory exists", () => {
      const store = openMemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "pref_one",
        type: "user",
        scope: "global",
        description: "prefers tabs",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(out).toContain("# User memory index");
      expect(out).toContain("memories[1]{scope,type,name,description}:");
      expect(out).toContain("global,user,pref_one,prefers tabs");
      expect(out).not.toContain("project,");
    });

    it("appends both blocks when both scopes populated", () => {
      const store = openMemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "global_one",
        type: "user",
        scope: "global",
        description: "g",
        body: "b",
      });
      store.write({
        name: "project_one",
        type: "project",
        scope: "project",
        description: "p",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(out).toContain("# User memory index");
      expect(out).toContain("global,user,global_one,g");
      expect(out).toContain("project,project,project_one,p");
      // Global precedes project — stable ordering for cache hash.
      expect(out.indexOf("global_one")).toBeLessThan(out.indexOf("project_one"));
    });

    it("is deterministic — identical state ⇒ identical output (cache-safe)", () => {
      const store = openMemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "stable",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      const a = applyUserMemory(BASE, { homeDir: home, projectRoot });
      const b = applyUserMemory(BASE, { homeDir: home, projectRoot });
      expect(a).toBe(b);
    });

    it("respects REASONIX_MEMORY=off", () => {
      const store = openMemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "pref_one",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      process.env.REASONIX_MEMORY = "off";
      expect(applyUserMemory(BASE, { homeDir: home, projectRoot })).toBe(BASE);
    });

    it("skips the project block when no projectRoot is configured", () => {
      const store = openMemoryStore({ homeDir: home });
      store.write({
        name: "global_only",
        type: "user",
        scope: "global",
        description: "d",
        body: "b",
      });
      const out = applyUserMemory(BASE, { homeDir: home });
      expect(out).toContain("# User memory index");
      expect(out).toContain("global,user,global_only,d");
      expect(out).not.toContain("project,");
    });
  });

  describe("applyMemoryStack", () => {
    it("composes REASONIX.md → global memory → project memory", () => {
      writeFileSync(join(projectRoot, "REASONIX.md"), "Pinned by REASONIX.md\n", "utf8");
      const withProj = applyProjectMemory(BASE, projectRoot);
      const store = openMemoryStore({ homeDir: home, projectRoot });
      store.write({
        name: "g_pref",
        type: "user",
        scope: "global",
        description: "global pref",
        body: "b",
      });
      store.write({
        name: "p_fact",
        type: "project",
        scope: "project",
        description: "project fact",
        body: "b",
      });
      const out = applyUserMemory(withProj, { homeDir: home, projectRoot });
      const iReasonix = out.indexOf("Pinned by REASONIX.md");
      const iGlobal = out.indexOf("g_pref");
      const iProject = out.indexOf("p_fact");
      expect(iReasonix).toBeGreaterThan(BASE.length - 1);
      expect(iGlobal).toBeGreaterThan(iReasonix);
      expect(iProject).toBeGreaterThan(iGlobal);
    });

    it("applyMemoryStack injects no memory blocks when no memory is set", () => {
      const out = applyMemoryStack(BASE, projectRoot, { homeDir: home });
      expect(out).toContain(BASE);
      expect(out).not.toMatch(/# Project memory/);
      expect(out).not.toMatch(/# User memory/);
      expect(out).not.toMatch(/# Global memory/);
    });
  });

  describe("applyGlobalReasonixMemory", () => {
    it("loads ~/.reasonix/REASONIX.md when present", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "- always pnpm not npm\n", "utf8");
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toContain("# Global memory");
      expect(out).toContain("always pnpm not npm");
      expect(out.startsWith(BASE)).toBe(true);
    });

    it("returns BASE unchanged when the file is missing", () => {
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toBe(BASE);
    });

    it("returns BASE unchanged when the file is empty / whitespace-only", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "   \n  \n", "utf8");
      const out = applyGlobalReasonixMemory(BASE, home);
      expect(out).toBe(BASE);
    });

    it("respects REASONIX_MEMORY=off opt-out", () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "REASONIX.md"), "- secret\n", "utf8");
      const orig = process.env.REASONIX_MEMORY;
      process.env.REASONIX_MEMORY = "off";
      try {
        const out = applyGlobalReasonixMemory(BASE, home);
        expect(out).toBe(BASE);
      } finally {
        if (orig === undefined) {
          // biome-ignore lint/performance/noDelete: env key must lose presence
          delete process.env.REASONIX_MEMORY;
        } else {
          process.env.REASONIX_MEMORY = orig;
        }
      }
    });
  });
});

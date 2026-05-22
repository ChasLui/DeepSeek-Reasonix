import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCompactors } from "../../../src/compact/filters/git.js";
import {
  applyCompactor,
  registerCompactor,
  resetCompactors,
} from "../../../src/compact/registry.js";

beforeEach(() => {
  resetCompactors();
  for (const c of gitCompactors) registerCompactor(c);
});
afterEach(() => {
  resetCompactors();
});

describe("git-status filter", () => {
  it("collapses porcelain output to summary + entries", () => {
    const out = [
      " M src/foo.ts",
      "M  src/bar.ts",
      "?? notes.md",
      "A  src/new.ts",
      "D  src/old.ts",
    ].join("\n");
    const r = applyCompactor("git status --porcelain", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("git-status");
    expect(r.compact).toMatch(/M:\d+/);
    expect(r.compact).toMatch(/\?:1/);
    expect(r.compact).toContain("notes.md");
  });

  it("reports clean tree for verbose status", () => {
    const out = ["On branch main", "nothing to commit, working tree clean"].join("\n");
    const r = applyCompactor("git status", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toMatch(/clean/);
    expect(r.compact).toMatch(/main/);
  });

  it("verbose: extracts changed sections", () => {
    const out = [
      "On branch feat/x",
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
      "\tmodified:   src/a.ts",
      "\tnew file:   src/b.ts",
      "",
      "Changes not staged for commit:",
      "\tmodified:   src/c.ts",
      "",
      "Untracked files:",
      "\tjunk.tmp",
    ].join("\n");
    const r = applyCompactor("git status", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("git-status");
    expect(r.compact).toMatch(/feat\/x/);
    expect(r.compact).toMatch(/staged:2/);
    expect(r.compact).toMatch(/unstaged:1/);
    expect(r.compact).toMatch(/untracked:1/);
    expect(r.compact).toContain("src/a.ts");
  });
});

describe("git-log filter", () => {
  it("counts oneline commits and caps long subjects", () => {
    const out = [
      "abc1234 first commit",
      "def5678 second commit with a longish subject line",
      "fed4321 third",
    ].join("\n");
    const r = applyCompactor("git log --oneline -10", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("git-log");
    expect(r.compact).toMatch(/3 commits/);
    expect(r.compact).toContain("abc1234");
  });

  it("collapses full-format commits to <sha> <subject>", () => {
    const out = [
      "commit abc1234abcdef",
      "Author: Foo <a@b>",
      "Date: now",
      "",
      "    add feature",
      "",
      "commit def5678abcdef",
      "Author: Bar <b@c>",
      "Date: later",
      "",
      "    fix bug",
    ].join("\n");
    const r = applyCompactor("git log", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("git-log");
    expect(r.compact).toMatch(/2 commits/);
    expect(r.compact).toMatch(/abc1234/);
    expect(r.compact).toMatch(/add feature/);
  });
});

describe("git-diff filter", () => {
  it("folds unchanged blocks but keeps +/- lines", () => {
    const out = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111..2222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,8 +1,8 @@",
      " context one",
      " context two",
      " context three",
      "-old line",
      "+new line",
      " context four",
      " context five",
      " context six",
    ].join("\n");
    const r = applyCompactor("git diff", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("git-diff");
    expect(r.compact).toMatch(/git diff — \+1\/-1/);
    expect(r.compact).toMatch(/unchanged/);
    expect(r.compact).toContain("+new line");
    expect(r.compact).toContain("-old line");
  });

  it("abstains when input has no diff header", () => {
    const r = applyCompactor("git diff --stat", "1 file changed", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });
});

describe("non-matching git subcommands", () => {
  it("git add does not match", () => {
    const r = applyCompactor("git add .", "", { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("passthrough");
  });
  it("git commit does not match", () => {
    const r = applyCompactor("git commit -m x", "[main abc] x", {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });
});

// Regression guard: the compactor is a pure post-processor on already-captured
// output — it never re-executes git, so it cannot inherit rtk's class of
// worktree bugs (re-running git in the wrong cwd / git-dir). These cases lock
// in safe behavior for the worktree-heavy command shapes.
describe("worktree safety", () => {
  it("git worktree list passes through (not a status/log/diff subcommand)", () => {
    const out = [
      "/repo                  abc1234 [main]",
      "/repo/.wt/feat-x       def5678 [feat/x]",
    ].join("\n");
    const r = applyCompactor("git worktree list", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
    expect(r.compact).toBe(out);
  });

  it("git -C <worktree> status: skips the -C value and still compacts", () => {
    const out = [" M src/foo.ts", "?? notes.md"].join("\n");
    const r = applyCompactor("git -C /repo/.wt/feat-x status --porcelain", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("git-status");
    expect(r.compact).toContain("src/foo.ts");
  });

  it("detached HEAD (common in worktrees): no data loss for changed files", () => {
    const out = [
      "HEAD detached at abc1234",
      "Changes not staged for commit:",
      "\tmodified:   src/a.ts",
    ].join("\n");
    const r = applyCompactor("git status", out, {
      exitCode: 0,
      timedOut: false,
    });
    // Branch label is unknown (shown as "?") but the changed file must survive.
    expect(r.compact).toContain("src/a.ts");
    expect(r.compact).toMatch(/unstaged:1/);
  });

  it("clean detached worktree reports clean without inventing a branch", () => {
    const out = ["HEAD detached at abc1234", "nothing to commit, working tree clean"].join("\n");
    const r = applyCompactor("git status", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.compact).toMatch(/clean/);
    expect(r.compact).not.toMatch(/on \w/i); // no fabricated "on <branch>"
  });

  it("porcelain v2 with branch headers abstains (# lines unrecognized)", () => {
    const out = [
      "# branch.oid abc1234",
      "# branch.head feat/x",
      "1 .M N... 100644 100644 100644 abc def src/foo.ts",
    ].join("\n");
    const r = applyCompactor("git status --porcelain=v2 --branch", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
    expect(r.compact).toBe(out);
  });
});

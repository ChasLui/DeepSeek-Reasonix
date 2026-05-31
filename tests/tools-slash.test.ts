import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handlers } from "../src/cli/ui/slash/handlers/tools.js";
import type { SlashContext } from "../src/cli/ui/slash/types.js";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { getDb, resetDb } from "../src/storage/db.js";
import { recordUnlock } from "../src/storage/unlocked-tools-repo.js";
import { PREFIX_MAX_TIER, ToolRegistry } from "../src/tools.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "reasonix-tools-slash-")), "reasonix.db");
}

function buildLoop(opts: {
  defer?: boolean;
  session?: string;
}): CacheFirstLoop {
  const tools = new ToolRegistry();
  tools.register({
    name: "read_file",
    description: "read a file",
    fn: () => "ok",
  });
  if (opts.defer) {
    tools.register({
      name: "github_create_issue",
      description: "open a GitHub issue",
      tier: 2,
      fn: () => "ok",
    });
    tools.register({
      name: "github_list_prs",
      description: "list pull requests",
      tier: 2,
      fn: () => "ok",
    });
    tools.register({
      name: "slack_post_message",
      description: "post a slack message",
      tier: 2,
      fn: () => "ok",
    });
  }
  const prefix = new ImmutablePrefix({
    system: "s",
    toolSpecs: tools.filteredSpecs(PREFIX_MAX_TIER),
  });
  const client = new DeepSeekClient({ apiKey: "sk-test" });
  return new CacheFirstLoop({
    client,
    prefix,
    tools,
    session: opts.session,
    stream: false,
  });
}

const ctx = {} as SlashContext;

afterEach(() => resetDb());

describe("/tools slash (Task 4.3 / FR-008)", () => {
  it("reports inactive tiering when nothing is deferred", () => {
    getDb(tmpDbPath());
    const loop = buildLoop({});
    const out = handlers.tools!([], loop, ctx).info ?? "";
    expect(out).toMatch(/0 deferred/);
    expect(out).toMatch(/inactive/i);
  });

  it("summarizes active vs deferred, grouped by server", () => {
    getDb(tmpDbPath());
    const loop = buildLoop({ defer: true });
    const out = handlers.tools!([], loop, ctx).info ?? "";
    expect(out).toMatch(/3 deferred/);
    expect(out).toMatch(/github \(2\)/);
    expect(out).toMatch(/slack \(1\)/);
  });

  it("shows the unlock audit trail for the session (FR-008)", () => {
    const db = getDb(tmpDbPath());
    recordUnlock(db, "audit-sess", "mcp", "github_create_issue", 0, "2026-05-31T00:00:00.000Z");
    const loop = buildLoop({ defer: true, session: "audit-sess" });
    const out = handlers.tools!([], loop, ctx).info ?? "";
    expect(out).toMatch(/Unlocked this session:.*github_create_issue/);
  });

  it("/tools search ranks deferred tools by intent", () => {
    getDb(tmpDbPath());
    const loop = buildLoop({ defer: true });
    const out = handlers.tools!(["search", "open", "a", "github", "issue"], loop, ctx).info ?? "";
    expect(out).toMatch(/github_create_issue/);
  });

  it("/tools search with no query → usage hint", () => {
    getDb(tmpDbPath());
    const loop = buildLoop({ defer: true });
    const out = handlers.tools!(["search"], loop, ctx).info ?? "";
    expect(out).toMatch(/Usage: \/tools search/);
  });

  it("/tools search with nothing deferred → graceful message", () => {
    getDb(tmpDbPath());
    const loop = buildLoop({});
    const out = handlers.tools!(["search", "anything"], loop, ctx).info ?? "";
    expect(out).toMatch(/No deferred tools/);
  });
});

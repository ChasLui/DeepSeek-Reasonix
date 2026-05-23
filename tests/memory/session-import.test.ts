import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexImportedClaudeSessions, searchMemory } from "../../src/cli/commands/memory.js";
import {
  importClaudeCodeSession,
  listSessions,
  loadSessionMessages,
} from "../../src/memory/session.js";

describe("Claude Code session import", () => {
  let home: string;
  let sourceDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-session-import-home-"));
    sourceDir = mkdtempSync(join(tmpdir(), "reasonix-session-import-source-"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("writes ChatMessage jsonl and source metadata", () => {
    const file = writeClaudeJsonl("one.jsonl", [
      { sessionId: "session-one", message: { role: "user", content: "hello" } },
      {
        sessionId: "session-one",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }],
        },
      },
    ]);

    const result = importClaudeCodeSession(file);

    expect(result.added).toBe(2);
    expect(existsSync(result.path)).toBe(true);
    expect(loadSessionMessages("session-one")).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "hi",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ]);
    expect(
      readFileSync(join(home, ".reasonix", "sessions", "session-one.meta.json"), "utf8"),
    ).toContain("claude-code");
  });

  it("is idempotent for duplicate session ids", () => {
    const file = writeClaudeJsonl("dup.jsonl", [
      { sessionId: "session-dup", message: { role: "user", content: "hello" } },
    ]);

    expect(importClaudeCodeSession(file).duplicate).toBe(false);
    const second = importClaudeCodeSession(file);

    expect(second.duplicate).toBe(true);
    expect(second.added).toBe(0);
    expect(listSessions({ sourceFilter: "claude-code" })).toHaveLength(1);
  });

  it("skips invalid lines while importing valid messages", () => {
    const file = join(sourceDir, "mixed.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ sessionId: "mixed", message: { role: "user", content: "hello" } }),
        JSON.stringify({ sessionId: "mixed", message: { content: "missing role" } }),
        "not-json",
      ].join("\n"),
      "utf8",
    );

    const result = importClaudeCodeSession(file);

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.reasons.invalid_message).toBe(1);
    expect(result.reasons.invalid_json).toBe(1);
  });

  it("normalizes tool_use content blocks into assistant tool calls", () => {
    const file = writeClaudeJsonl("tool-use.jsonl", [
      {
        sessionId: "tool-use",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
      },
    ]);

    importClaudeCodeSession(file);

    expect(loadSessionMessages("tool-use")[0]?.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
  });

  it("skips rows with malformed declared tool calls", () => {
    const file = writeClaudeJsonl("bad-declared-tool.jsonl", [
      { sessionId: "bad-declared-tool", message: { role: "user", content: "keep me" } },
      {
        sessionId: "bad-declared-tool",
        message: {
          role: "assistant",
          content: "bad call",
          tool_calls: [{ id: "call_1", function: { arguments: "{}" } }],
        },
      },
    ]);

    const result = importClaudeCodeSession(file);

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.reasons.invalid_tool_call).toBe(1);
    expect(loadSessionMessages("bad-declared-tool")).toEqual([
      { role: "user", content: "keep me" },
    ]);
  });

  it("skips rows with malformed tool_use content blocks", () => {
    const file = writeClaudeJsonl("bad-tool-use.jsonl", [
      {
        sessionId: "bad-tool-use",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "bad call" },
            { type: "tool_use", id: "call_1", input: { path: "a.ts" } },
          ],
        },
      },
    ]);

    const result = importClaudeCodeSession(file);

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.reasons.invalid_tool_call).toBe(1);
    expect(existsSync(result.path)).toBe(false);
  });

  it("indexes imported Claude Code sessions only when explicitly requested", async () => {
    const file = writeClaudeJsonl("indexed.jsonl", [
      {
        sessionId: "indexed-session",
        message: { role: "user", content: "How do we handle prompt cache drift?" },
      },
      {
        sessionId: "indexed-session",
        message: { role: "assistant", content: "Check prefix fingerprint drift." },
      },
    ]);
    importClaudeCodeSession(file);
    const reasonixHome = join(home, ".reasonix");

    expect((await searchMemory("prompt cache", { homeDir: reasonixHome })).hits).toEqual([]);

    const indexed = await indexImportedClaudeSessions({
      homeDir: reasonixHome,
      embedText: async () => new Float32Array([1, 0]),
    });
    const result = await searchMemory("prompt cache", { homeDir: reasonixHome });

    expect(indexed.indexed).toBe(1);
    expect(result.hits[0]?.entry.description).toContain("indexed-session");
  });

  it("rejects missing paths and oversize files", () => {
    expect(() => importClaudeCodeSession(join(sourceDir, "missing.jsonl"))).toThrow();
    const large = join(sourceDir, "large.jsonl");
    writeFileSync(large, "x", "utf8");
    truncateSync(large, 51 * 1024 * 1024);
    expect(() => importClaudeCodeSession(large)).toThrow(/too large/);
  });

  function writeClaudeJsonl(name: string, rows: readonly unknown[]): string {
    mkdirSync(sourceDir, { recursive: true });
    const file = join(sourceDir, name);
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return file;
  }
});

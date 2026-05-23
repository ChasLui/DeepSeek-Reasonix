import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ResolvedHook, runHooks } from "../../src/hooks.js";
import {
  countRecentObservationEvents,
  extractObservationFromHook,
} from "../../src/memory/observation.js";
import { MemoryStore } from "../../src/memory/user.js";

describe("hook-driven memory observation", () => {
  let home: string;
  let projectRoot: string;
  let store: MemoryStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-observation-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-observation-project-"));
    store = new MemoryStore({ homeDir: home, projectRoot });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("does nothing when autoCapture is false", async () => {
    const result = await extractObservationFromHook(stopPayload(), validRaw("capture_one"), {
      store,
      autoCapture: false,
    });

    expect(result).toEqual({ written: 0, skipped: 0, reasons: [] });
    expect(store.list()).toEqual([]);
  });

  it("writes a valid v1 observation when enabled", async () => {
    const result = await extractObservationFromHook(stopPayload(), validRaw("capture_one"), {
      store,
      autoCapture: true,
    });

    expect(result.written).toBe(1);
    expect(store.read("project", "capture_one").body).toBe("Remember this.");
    expect(countRecentObservationEvents(home)).toBe(1);
  });

  it("honors REASONIX_MEMORY_AUTO=0 as a kill switch", async () => {
    vi.stubEnv("REASONIX_MEMORY_AUTO", "0");

    const result = await extractObservationFromHook(stopPayload(), validRaw("capture_one"), {
      store,
      autoCapture: true,
    });

    expect(result.written).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("rejects unsupported versions, invalid types, invalid names, and oversize fields", async () => {
    const lines = [
      { v: 2, type: "project", name: "bad_version", description: "d", body: "b" },
      { v: 1, type: "unknown", name: "bad_type", description: "d", body: "b" },
      { v: 1, type: "project", name: "../bad", description: "d", body: "b" },
      { v: 1, type: "project", name: "long_desc", description: "x".repeat(201), body: "b" },
      { v: 1, type: "project", name: "long_body", description: "d", body: "x".repeat(8193) },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");

    const result = await extractObservationFromHook(
      stopPayload(),
      { stdout: lines, stderr: "" },
      { store, autoCapture: true },
    );

    expect(result.written).toBe(0);
    expect(result.reasons).toEqual([
      "unsupported_version",
      "invalid_type",
      "invalid_name",
      "description_too_long",
      "body_too_large",
    ]);
  });

  it("allows declared custom memory types", async () => {
    const result = await extractObservationFromHook(
      stopPayload(),
      validRaw("custom_one", "incident"),
      {
        store,
        autoCapture: true,
        config: { memory: { customTypes: [{ name: "incident" }] } },
      },
    );

    expect(result.written).toBe(1);
    expect(store.read("project", "custom_one").type).toBe("incident");
  });

  it("enforces line, write, byte, and token budgets", async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        v: 1,
        type: "project",
        name: `cap_${i}`,
        description: "d",
        body: "body",
      }),
    ).join("\n");

    const result = await extractObservationFromHook(
      stopPayload(),
      { stdout: many, stderr: "" },
      {
        store,
        autoCapture: true,
        budgets: { maxLines: 4, maxWrites: 2, aggregateBytes: 1000, aggregateTokens: 1000 },
      },
    );

    expect(result.written).toBe(2);
    expect(result.reasons).toContain("max_writes");

    const byteResult = await extractObservationFromHook(stopPayload(), validRaw("byte_cap"), {
      store,
      autoCapture: true,
      budgets: { aggregateBytes: 10 },
    });
    expect(byteResult.reasons).toContain("aggregate_bytes");

    const tokenResult = await extractObservationFromHook(stopPayload(), validRaw("token_cap"), {
      store,
      autoCapture: true,
      budgets: { aggregateTokens: 1 },
    });
    expect(tokenResult.reasons).toContain("aggregate_tokens");
  });

  it("does not alter runHooks outcome shape or duration materially", async () => {
    const hook: ResolvedHook = {
      event: "Stop",
      scope: "project",
      source: "test",
      command: "printf observation",
    };
    const start = Date.now();

    const report = await runHooks({
      hooks: [hook],
      payload: stopPayload(),
      spawner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          v: 1,
          type: "project",
          name: "hook_obs",
          description: "d",
          body: "b",
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    const elapsed = Date.now() - start;

    expect(report).toMatchObject({ event: "Stop", blocked: false });
    expect(report.outcomes[0]).toMatchObject({ decision: "pass", exitCode: 0 });
    expect(elapsed).toBeLessThan(5);
  });
});

function stopPayload() {
  return {
    event: "Stop" as const,
    cwd: process.cwd(),
    lastAssistantText: "done",
    turn: 1,
  };
}

function validRaw(name: string, type = "project") {
  return {
    stdout: JSON.stringify({
      v: 1,
      type,
      name,
      description: "Useful distilled observation",
      body: "Remember this.",
    }),
    stderr: "",
  };
}

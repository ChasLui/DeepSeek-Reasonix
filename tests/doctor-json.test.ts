/** `reasonix doctor --json` — structured report shape and exit-code semantics. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DoctorCheck,
  doctorCommand,
  formatDoctorJson,
  runDoctorChecks,
} from "../src/cli/commands/doctor.js";
import { defaultConfigPath, writeConfig } from "../src/config.js";
import { VERSION } from "../src/version.js";

describe("formatDoctorJson", () => {
  it("emits version, summary, and {id,status,message} per check", () => {
    const checks: DoctorCheck[] = [
      { id: "api-key", label: "api key", level: "ok", detail: "set via env" },
      { id: "prompt-cache", label: "prompt-cache", level: "info", detail: "best-effort" },
      { id: "tokenizer", label: "tokenizer", level: "warn", detail: "fallback" },
      { id: "api-reach", label: "api reach", level: "fail", detail: "boom" },
    ];
    const parsed = JSON.parse(formatDoctorJson(checks, "0.18.1"));

    expect(parsed.version).toBe("0.18.1");
    expect(parsed.summary).toEqual({ ok: 1, info: 1, warn: 1, fail: 1 });
    expect(parsed.checks).toEqual([
      { id: "api-key", status: "ok", message: "set via env" },
      { id: "prompt-cache", status: "info", message: "best-effort" },
      { id: "tokenizer", status: "warn", message: "fallback" },
      { id: "api-reach", status: "fail", message: "boom" },
    ]);
  });

  it("produces a single-line, jq-parseable document", () => {
    const out = formatDoctorJson(
      [{ id: "api-key", label: "api key", level: "ok", detail: "set" }],
      "1.2.3",
    );
    expect(out).not.toContain("\n");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("counts an empty check list as all zeros", () => {
    const parsed = JSON.parse(formatDoctorJson([], VERSION));
    expect(parsed.summary).toEqual({ ok: 0, info: 0, warn: 0, fail: 0 });
    expect(parsed.checks).toEqual([]);
  });
});

describe("doctorCommand --json (integration)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpHome: string;
  let tmpCwd: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "reasonix-doctor-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "reasonix-doctor-cwd-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
    // Ensure no API key so checkApiReach skips the network call.
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    process.chdir(tmpCwd);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("emits exactly one line of valid JSON when --json is set", async () => {
    await doctorCommand({ json: true });

    // No header, no per-check prints, no summary leak — only the JSON document.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = String(logSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(out);

    expect(parsed.version).toBe(VERSION);
    expect(parsed.summary).toMatchObject({
      ok: expect.any(Number),
      warn: expect.any(Number),
      fail: expect.any(Number),
    });
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toContainEqual({
      id: "toon",
      status: "ok",
      message: expect.stringContaining("enabled mode=all"),
    });
    expect(parsed.checks).toContainEqual({
      id: "prompt-cache",
      status: "ok",
      message: expect.stringContaining("session-local stats unavailable"),
    });
    expect(parsed.checks).toContainEqual({
      id: "cache",
      status: "ok",
      message: expect.stringContaining("file-cache enabled; parse-cache enabled"),
    });
    for (const c of parsed.checks) {
      expect(typeof c.id).toBe("string");
      expect(["ok", "info", "warn", "fail"]).toContain(c.status);
      expect(typeof c.message).toBe("string");
    }
  });

  it("exits 1 when the report contains any fail status", async () => {
    // checkApiKey returns `fail` when neither env nor config has a key —
    // our temp HOME has no config, and we deleted DEEPSEEK_API_KEY.
    await doctorCommand({ json: true });

    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    if (parsed.summary.fail > 0) {
      expect(exitSpy).toHaveBeenCalledWith(1);
    } else {
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });

  it("reports live prompt-cache stats when a TUI loop supplies them", async () => {
    const checks = await runDoctorChecks(tmpCwd, {
      promptCacheStats: {
        enabled: true,
        hitTokens: 9000,
        missTokens: 1000,
        hitRatio: 0.9,
        breaks: 1,
        writeFailures: 0,
        recentBreakCategories: ["system"],
        lastBreakReason: "system changed",
      },
    });

    expect(checks.find((c) => c.id === "prompt-cache")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("90.0% hit · 1 breaks · last: system changed"),
    });
  });

  it("reports prompt-cache disabled when the supplied monitor stats are disabled", async () => {
    const checks = await runDoctorChecks(tmpCwd, {
      promptCacheStats: {
        enabled: false,
        hitTokens: 0,
        missTokens: 0,
        hitRatio: 0,
        breaks: 0,
        writeFailures: 0,
      },
    });

    expect(checks.find((c) => c.id === "prompt-cache")).toMatchObject({
      level: "info",
      detail: "disabled via REASONIX_PROMPT_CACHE_MONITOR=0",
    });
  });

  it("warns when legacy rateLimit.rpm is configured", async () => {
    writeConfig({ rateLimit: { rpm: 30 } }, defaultConfigPath());

    const checks = await runDoctorChecks(tmpCwd);

    expect(checks.find((c) => c.id === "rate-limit")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("deprecated"),
    });
  });

  it("reports default concurrency caps as upstream limits", async () => {
    const checks = await runDoctorChecks(tmpCwd);

    expect(checks.find((c) => c.id === "rate-limit")).toMatchObject({
      level: "ok",
      detail: expect.stringContaining("(default cap = upstream limit)"),
    });
  });

  it("reports manual cap narrowing and adaptive disabled mode", async () => {
    writeConfig({ rateLimit: { concurrency: { pro: 16, adaptive: false } } }, defaultConfigPath());

    const checks = await runDoctorChecks(tmpCwd);
    const detail = checks.find((c) => c.id === "rate-limit")?.detail ?? "";

    expect(detail).toContain("manually narrowed (default 500");
    expect(detail).toContain("adaptive disabled (manual mode)");
  });
});

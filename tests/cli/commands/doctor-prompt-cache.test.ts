import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctorChecks } from "../../../src/cli/commands/doctor.js";
import type { PromptCacheStats } from "../../../src/observability/prompt-cache-monitor.js";

describe("doctor prompt-cache grading", () => {
  let tmpHome: string;
  let tmpCwd: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "reasonix-doctor-prompt-cache-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "reasonix-doctor-prompt-cache-cwd-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("reports fallback-only cache breaks as info", async () => {
    const check = await promptCacheCheck({
      breaks: 3,
      recentBreakCategories: ["recent-miss", "older-miss", "best-effort-miss"],
      lastBreakReason: "older miss",
    });

    expect(check).toMatchObject({
      level: "info",
      detail: expect.stringContaining("DeepSeek best-effort cache; no local prompt drift"),
    });
  });

  it("warns when a real prompt drift category is present", async () => {
    const check = await promptCacheCheck({
      breaks: 2,
      recentBreakCategories: ["recent-miss", "system"],
      lastBreakReason: "system changed",
    });

    expect(check).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("local prompt drift category=system"),
    });
  });

  it("keeps legacy ttl categories conservative", async () => {
    const check = await promptCacheCheck({
      breaks: 1,
      recentBreakCategories: ["ttl-1h"],
      lastBreakReason: "possible 1h TTL expiry",
    });

    expect(check).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("local prompt drift category=ttl-1h"),
    });
  });

  it("warns when diff patch writes have failed", async () => {
    const check = await promptCacheCheck({
      breaks: 1,
      writeFailures: 2,
      recentBreakCategories: ["recent-miss"],
      lastBreakReason: "recent miss",
    });

    expect(check).toMatchObject({
      level: "warn",
      detail: expect.stringContaining(
        "diff patch write failed 2 times — check ~/.reasonix/tmp/ permissions",
      ),
    });
  });

  async function promptCacheCheck(overrides: Partial<PromptCacheStats>) {
    const checks = await runDoctorChecks(tmpCwd, {
      promptCacheStats: {
        enabled: true,
        hitTokens: 9000,
        missTokens: 1000,
        hitRatio: 0.9,
        breaks: 0,
        writeFailures: 0,
        ...overrides,
      },
    });
    return checks.find((c) => c.id === "prompt-cache");
  }
});

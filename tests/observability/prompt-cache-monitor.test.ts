import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptFingerprint } from "../../src/cache/prompt-fingerprint.js";
import { ImmutablePrefix } from "../../src/memory/runtime.js";
import {
  PromptCacheMonitor,
  classifyPromptCacheFallback,
} from "../../src/observability/prompt-cache-monitor.js";
import type { ChatMessage, ToolSpec } from "../../src/types.js";

const ENV_KEYS = ["REASONIX_PROMPT_CACHE_MONITOR", "REASONIX_CACHE_BREAK_DIFF"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PromptCacheMonitor", () => {
  it("does not break on stable cache hits", () => {
    const { monitor } = makeMonitor();
    const snap = snapshot("system", [tool("alpha")]);

    monitor.recordBeforeCall(snap);
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordBeforeCall(snap);
    monitor.recordAfterCall({ hit: 10000 }, []);

    expect(monitor.getReport()).toEqual([]);
  });

  it("breaks on a large cache-hit drop and names changed tools", () => {
    const tmp = makeTmpDir();
    const { monitor } = makeMonitor(tmp);
    silenceStderr();

    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "old")]));
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "new")]));
    monitor.recordAfterCall({ hit: 5000 }, [assistant("plain reply body")]);

    const report = monitor.getReport()[0];
    expect(report?.reason).toContain("alpha");
    expect(report?.dropTokens).toBe(5000);
    const files = readdirSync(tmp);
    expect(files).toHaveLength(1);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("ignores undefined and null cache-hit usage", () => {
    const { monitor } = makeMonitor();
    const snap = snapshot("system", [tool("alpha")]);

    monitor.recordBeforeCall(snap);
    monitor.recordAfterCall(undefined, []);
    monitor.recordBeforeCall(snap);
    monitor.recordAfterCall({ hit: null }, []);

    expect(monitor.getReport()).toEqual([]);
  });

  it("resetBaseline prevents the next cold miss from counting as a break", () => {
    const { monitor } = makeMonitor();

    monitor.recordBeforeCall(snapshot("system", [tool("alpha")]));
    monitor.recordAfterCall({ hit: 5000 }, []);
    monitor.resetBaseline();
    monitor.recordBeforeCall(snapshot("system changed", [tool("alpha")]));
    monitor.recordAfterCall({ hit: 0 }, []);

    expect(monitor.getReport()).toEqual([]);
  });

  it("handles hit=0 boundary cases exactly", () => {
    expect(runDropCase(null, 0)).toBe(false);
    expect(runDropCase(0, 0)).toBe(false);
    expect(runDropCase(2000, 0)).toBe(false);
    expect(runDropCase(2001, 0)).toBe(true);
  });

  it("classifies as recent-miss when prev call < 10 min ago", () => {
    silenceStderr();

    const report = runFallbackCase(9 * 60 * 1000);

    expect(report?.reasonCategory).toBe("recent-miss");
    expect(report?.reason).toContain(
      "recent miss (< 10 min, likely server-side eviction within DeepSeek best-effort cache window)",
    );
  });

  it("classifies as older-miss when prev call >= 10 min ago", () => {
    silenceStderr();

    const report = runFallbackCase(10 * 60 * 1000);

    expect(report?.reasonCategory).toBe("older-miss");
    expect(report?.reason).toContain(
      "older miss (≥ 10 min, possible TTL expiry; DeepSeek TTL is non-deterministic 'hours to days')",
    );
  });

  it("classifies as best-effort-miss when no prev call baseline", () => {
    const reason = classifyPromptCacheFallback(null);

    expect(reason.category).toBe("best-effort-miss");
    expect(reason.text).toContain(
      "best-effort miss (no prior call baseline; DeepSeek does not guarantee 100% cache hit)",
    );
  });

  it("suppresses precise epoch matches but reports epoch plus extra drift", () => {
    silenceStderr();

    const epochOnly = makeMonitor().monitor;
    epochOnly.recordBeforeCall(snapshot("system", []));
    epochOnly.recordAfterCall({ hit: 10000 }, []);
    epochOnly.recordEpochEvent("prefix-mutation", { added: ["alpha"] });
    epochOnly.recordBeforeCall(snapshot("system", [tool("alpha")]));
    epochOnly.recordAfterCall({ hit: 5000 }, []);
    expect(epochOnly.getReport()).toEqual([]);

    const extra = makeMonitor().monitor;
    extra.recordBeforeCall(snapshot("system", []));
    extra.recordAfterCall({ hit: 10000 }, []);
    extra.recordEpochEvent("prefix-mutation", { added: ["alpha"] });
    extra.recordBeforeCall(snapshot("system changed", [tool("alpha")]));
    extra.recordAfterCall({ hit: 5000 }, []);

    expect(extra.getReport()[0]).toMatchObject({
      epochLabel: "prefix-mutation",
      reasonCategory: "epoch-leak",
    });
  });

  it("reports a break when tool order drifts under a pending epoch", () => {
    silenceStderr();
    const { monitor } = makeMonitor();

    monitor.recordBeforeCall(snapshot("system", [tool("alpha"), tool("bravo")]));
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordEpochEvent("prefix-mutation", { added: [], removed: [] });
    monitor.recordBeforeCall(snapshot("system", [tool("bravo"), tool("alpha")]));
    monitor.recordAfterCall({ hit: 5000 }, []);

    expect(monitor.getReport()).toHaveLength(1);
  });

  it("merges multiple epoch events of the same label", () => {
    silenceStderr();
    const { monitor } = makeMonitor();

    monitor.recordBeforeCall(snapshot("system", []));
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordEpochEvent("prefix-mutation", { added: ["alpha"] });
    monitor.recordEpochEvent("prefix-mutation", { added: ["bravo"] });
    monitor.recordEpochEvent("prefix-mutation", { added: ["charlie"] });
    monitor.recordBeforeCall(snapshot("system", [tool("alpha"), tool("bravo"), tool("charlie")]));
    monitor.recordAfterCall({ hit: 5000 }, []);

    expect(monitor.getReport()).toEqual([]);
  });

  it("writes diff patches with random filenames and owner-only mode", () => {
    const tmp = makeTmpDir();
    const { monitor } = makeMonitor(tmp);
    silenceStderr();

    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "old")]));
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "new")]));
    monitor.recordAfterCall({ hit: 5000 }, []);

    const files = readdirSync(tmp);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^cache-break-[0-9a-f]{12}\.diff$/);
    if (process.platform !== "win32") {
      const stat = statSync(join(tmp, files[0]!));
      expect(stat.mode & 0o777).toBe(0o600);
    }

    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves URL host and path in diff patches", () => {
    const tmp = makeTmpDir();
    const { monitor } = makeMonitor(tmp);
    silenceStderr();

    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "old")]));
    monitor.recordAfterCall({ hit: 10000 }, []);
    monitor.recordBeforeCall(snapshot("system", [tool("alpha", "new")]));
    monitor.recordAfterCall({ hit: 5000 }, [
      assistant("see https://api.example.com/v1/users/me for context"),
    ]);

    const files = readdirSync(tmp);
    const patch = readFileSync(join(tmp, files[0]!), "utf8");
    expect(patch).toContain("https://api.example.com/v1/users/me");
    expect(patch).not.toMatch(/example\.com[a-z]/i);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("disables all recording and patch writes via kill switches", () => {
    const tmp = makeTmpDir();
    process.env.REASONIX_PROMPT_CACHE_MONITOR = "0";
    const disabled = new PromptCacheMonitor({ tmpDir: tmp });

    disabled.recordBeforeCall(snapshot("system", [tool("alpha")]));
    disabled.recordAfterCall({ hit: 10000 }, []);
    disabled.recordBeforeCall(snapshot("changed", [tool("alpha")]));
    disabled.recordAfterCall({ hit: 0 }, []);

    expect(disabled.stats()).toMatchObject({ enabled: false, breaks: 0 });
    expect(readdirSync(tmp)).toEqual([]);

    Reflect.deleteProperty(process.env, "REASONIX_PROMPT_CACHE_MONITOR");
    process.env.REASONIX_CACHE_BREAK_DIFF = "0";
    const noDiff = new PromptCacheMonitor({ tmpDir: tmp });
    silenceStderr();
    noDiff.recordBeforeCall(snapshot("system", [tool("alpha")]));
    noDiff.recordAfterCall({ hit: 10000 }, []);
    noDiff.recordBeforeCall(snapshot("changed", [tool("alpha")]));
    noDiff.recordAfterCall({ hit: 0 }, []);

    expect(noDiff.getReport()).toHaveLength(1);
    expect(existsSync(tmp)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

function runDropCase(prev: number | null, next: number): boolean {
  const { monitor } = makeMonitor();
  silenceStderr();
  if (prev !== null) {
    monitor.recordBeforeCall(snapshot("system", [tool("alpha")]));
    monitor.recordAfterCall({ hit: prev }, []);
  }
  monitor.recordBeforeCall(snapshot("system", [tool("alpha")]));
  monitor.recordAfterCall({ hit: next }, []);
  return monitor.getReport().length > 0;
}

function runFallbackCase(intervalMs: number) {
  vi.useFakeTimers();
  const { monitor } = makeMonitor();
  const snap = snapshot("system", [tool("alpha")]);

  monitor.recordBeforeCall(snap);
  monitor.recordAfterCall({ hit: 10000 }, []);
  vi.advanceTimersByTime(intervalMs);
  monitor.recordBeforeCall(snap);
  monitor.recordAfterCall({ hit: 5000 }, []);
  vi.useRealTimers();
  return monitor.getReport()[0];
}

function snapshot(system: string, tools: readonly ToolSpec[]) {
  return new PromptFingerprint().snapshot(new ImmutablePrefix({ system, toolSpecs: tools }));
}

function tool(name: string, description = "description"): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object" },
    },
  };
}

function assistant(content = "ok"): ChatMessage {
  return { role: "assistant", content };
}

function makeMonitor(tmpDir = makeTmpDir()): {
  monitor: PromptCacheMonitor;
  tmpDir: string;
} {
  return {
    monitor: new PromptCacheMonitor({
      tmpDir,
      minDropTokens: 2000,
      dropRatio: 0.05,
    }),
    tmpDir,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "reasonix-cache-monitor-"));
}

function silenceStderr(): void {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

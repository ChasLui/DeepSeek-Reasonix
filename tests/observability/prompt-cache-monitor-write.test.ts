import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolSpec } from "../../src/types.js";

type OpenSyncArgs = Parameters<typeof import("node:fs").openSync>;
type PromptMonitorModule = typeof import("../../src/observability/prompt-cache-monitor.js");
type PromptFingerprintModule = typeof import("../../src/cache/prompt-fingerprint.js");
type MemoryRuntimeModule = typeof import("../../src/memory/runtime.js");
type PromptRuntime = {
  PromptCacheMonitor: PromptMonitorModule["PromptCacheMonitor"];
  PromptFingerprint: PromptFingerprintModule["PromptFingerprint"];
  ImmutablePrefix: MemoryRuntimeModule["ImmutablePrefix"];
};
type PromptCacheMonitorInstance = InstanceType<PromptMonitorModule["PromptCacheMonitor"]>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:crypto");
});

describe("PromptCacheMonitor diff patch writes", () => {
  it("opens patch files with O_NOFOLLOW on POSIX", async () => {
    if (process.platform === "win32") return;
    const tmp = makeTmpDir();
    const openCalls: OpenSyncArgs[] = [];
    mockOpenSync(openCalls);
    const runtime = await loadPromptRuntime();
    silenceDiagnostics();

    triggerBreak(runtime, new runtime.PromptCacheMonitor({ tmpDir: tmp, minDropTokens: 2000 }));

    const { constants } = await import("node:fs");
    const flags = openCalls.find((call) => typeof call[1] === "number")?.[1];
    expect((flags as number | undefined)! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves break history when random filenames collide three times", async () => {
    const tmp = makeTmpDir();
    const random = Buffer.from("abcdef");
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return { ...actual, randomBytes: () => random };
    });
    const id = random.toString("hex");
    writeFileSync(join(tmp, `cache-break-${id}.diff`), "existing");
    const runtime = await loadPromptRuntime();
    const monitor = new runtime.PromptCacheMonitor({ tmpDir: tmp, minDropTokens: 2000 });
    silenceDiagnostics();

    triggerBreak(runtime, monitor);

    const report = monitor.getReport()[0];
    expect(monitor.stats().writeFailures).toBe(1);
    expect(report?.writeError).toContain("EEXIST after 3 attempts");
    expect(report?.diffPatchPath).toBeUndefined();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses wx when O_NOFOLLOW has no platform value", async () => {
    const tmp = makeTmpDir();
    const openCalls: OpenSyncArgs[] = [];
    mockOpenSync(openCalls);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const runtime = await loadPromptRuntime();
    silenceDiagnostics();

    triggerBreak(runtime, new runtime.PromptCacheMonitor({ tmpDir: tmp, minDropTokens: 2000 }));

    expect(openCalls.some((call) => call[1] === "wx")).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates cache-break parent directories with owner-only modes", async () => {
    if (process.platform === "win32") return;
    const tmp = makeTmpDir();
    const tmpDir = join(tmp, ".reasonix", "tmp");
    const oldUmask = process.umask(0o022);
    const runtime = await loadPromptRuntime();
    silenceDiagnostics();
    try {
      triggerBreak(runtime, new runtime.PromptCacheMonitor({ tmpDir, minDropTokens: 2000 }));
    } finally {
      process.umask(oldUmask);
    }

    expect(statSync(join(tmp, ".reasonix")).mode & 0o777).toBe(0o700);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    rmSync(tmp, { recursive: true, force: true });
  });
});

function mockOpenSync(openCalls: OpenSyncArgs[]): void {
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      openSync: (...args: OpenSyncArgs) => {
        openCalls.push(args);
        return actual.openSync(...args);
      },
    };
  });
}

async function loadPromptRuntime(): Promise<PromptRuntime> {
  const [{ PromptCacheMonitor }, { PromptFingerprint }, { ImmutablePrefix }] = await Promise.all([
    import("../../src/observability/prompt-cache-monitor.js"),
    import("../../src/cache/prompt-fingerprint.js"),
    import("../../src/memory/runtime.js"),
  ]);
  return { PromptCacheMonitor, PromptFingerprint, ImmutablePrefix };
}

function triggerBreak(runtime: PromptRuntime, monitor: PromptCacheMonitorInstance): void {
  monitor.recordBeforeCall(snapshot(runtime, "system", [tool("alpha", "old")]));
  monitor.recordAfterCall({ hit: 10_000 }, []);
  monitor.recordBeforeCall(snapshot(runtime, "system", [tool("alpha", "new")]));
  monitor.recordAfterCall({ hit: 5000 }, []);
}

function snapshot(runtime: PromptRuntime, system: string, tools: readonly ToolSpec[]) {
  return new runtime.PromptFingerprint().snapshot(
    new runtime.ImmutablePrefix({ system, toolSpecs: tools }),
  );
}

function tool(name: string, description: string): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object" },
    },
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "reasonix-cache-monitor-write-"));
}

function silenceDiagnostics(): void {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

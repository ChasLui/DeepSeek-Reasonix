import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildCodeToolset: vi.fn(),
  chatCommand: vi.fn(),
  codeSystemPrompt: vi.fn(() => "code prompt"),
  disableMouseMode: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock("../src/code/setup.js", () => ({
  buildCodeToolset: mocks.buildCodeToolset,
}));

vi.mock("../src/code/prompt.js", () => ({
  codeSystemPrompt: mocks.codeSystemPrompt,
}));

vi.mock("../src/cli/commands/chat.js", () => ({
  chatCommand: mocks.chatCommand,
}));

vi.mock("../src/cli/ui/mouse-mode.js", () => ({
  disableMouseMode: mocks.disableMouseMode,
}));

describe("codeCommand terminal cleanup", () => {
  let dir: string;
  let onceSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const listeners = new Map<string | symbol, (...args: unknown[]) => void>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-code-cleanup-"));
    listeners.clear();
    mocks.buildCodeToolset.mockReset();
    mocks.chatCommand.mockReset();
    mocks.codeSystemPrompt.mockClear();
    mocks.disableMouseMode.mockClear();
    mocks.shutdown.mockClear();
    mocks.buildCodeToolset.mockResolvedValue({
      tools: { size: 0 },
      jobs: { shutdown: mocks.shutdown },
      registerRooted: vi.fn(),
      reBootstrapSemantic: vi.fn(async () => ({ enabled: false })),
      semantic: { enabled: false },
    });
    mocks.chatCommand.mockResolvedValue(undefined);
    onceSpy = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      listeners.set(event, listener as (...args: unknown[]) => void);
      return process;
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    onceSpy.mockRestore();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers mouse cleanup for exit and signals in code mode", async () => {
    const { codeCommand } = await import("../src/cli/commands/code.js");

    await codeCommand({ dir, noDashboard: true });

    listeners.get("exit")?.();
    expect(mocks.disableMouseMode).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);

    listeners.get("SIGTERM")?.();
    expect(mocks.disableMouseMode).toHaveBeenCalledTimes(2);
    expect(mocks.shutdown).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(143);
  });
});

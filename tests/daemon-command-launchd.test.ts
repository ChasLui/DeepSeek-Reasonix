import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stderr: "" })),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const spawnSyncMock = vi.mocked(spawnSync);
const existsSyncMock = vi.mocked(existsSync);

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.reasonix.daemon.plist");
}

function launchdService(): string {
  return `gui/${process.getuid?.() ?? 0}/com.reasonix.daemon`;
}

describe("daemon launchd commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stderr: "" } as ReturnType<typeof spawnSync>);
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
  });

  it("stops an installed macOS service with bootout so KeepAlive does not relaunch it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { daemonStopCommand } = await import("../src/cli/commands/daemon.js");

    await daemonStopCommand();

    expect(spawnSyncMock).toHaveBeenCalledWith("launchctl", ["bootout", launchdService()], {
      encoding: "utf8",
    });
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      "launchctl",
      ["kill", "SIGTERM", launchdService()],
      expect.anything(),
    );
    expect(stdout).toHaveBeenCalledWith("daemon stop signalled\n");
  });

  it("re-bootstraps an installed macOS service before kickstart when stop unloaded it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    spawnSyncMock
      .mockReturnValueOnce({ status: 113, stderr: "not loaded" } as ReturnType<typeof spawnSync>)
      .mockReturnValue({ status: 0, stderr: "" } as ReturnType<typeof spawnSync>);
    const { daemonStartCommand } = await import("../src/cli/commands/daemon.js");

    await daemonStartCommand();

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "launchctl", ["print", launchdService()], {
      encoding: "utf8",
    });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "launchctl",
      ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath()],
      { encoding: "utf8" },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(3, "launchctl", ["kickstart", launchdService()], {
      encoding: "utf8",
    });
  });

  it("keeps launchd plist removal scoped to uninstall", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { daemonStopCommand, daemonUninstallCommand } = await import(
      "../src/cli/commands/daemon.js"
    );

    await daemonStopCommand();
    expect(rmSync).not.toHaveBeenCalled();

    await daemonUninstallCommand();
    expect(rmSync).toHaveBeenCalledWith(plistPath(), { force: true });
  });

  it("installs launchd service by writing plist then bootstrapping it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { daemonInstallCommand } = await import("../src/cli/commands/daemon.js");

    await daemonInstallCommand();

    expect(mkdirSync).toHaveBeenCalledWith(join(homedir(), "Library", "LaunchAgents"), {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(plistPath(), expect.stringContaining("KeepAlive"));
    expect(spawnSyncMock).toHaveBeenCalledWith("launchctl", ["bootout", launchdService()], {
      encoding: "utf8",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath()],
      { encoding: "utf8" },
    );
  });
});

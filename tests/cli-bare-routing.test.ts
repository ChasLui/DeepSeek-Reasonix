/** Bare `reasonix` routing — defaults to code mode in the current directory; explicit `chat` stays chat. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "../src/config.js";

const codeCommand = vi.fn(async () => {});
const codeRemoteCommand = vi.fn(async () => {});
const chatCommand = vi.fn(async () => {});
const setupCommand = vi.fn(async () => {});

vi.mock("../src/cli/commands/code.js", () => ({ codeCommand }));
vi.mock("../src/cli/commands/code-remote.js", () => ({ codeRemoteCommand }));
vi.mock("../src/cli/commands/chat.js", () => ({ chatCommand }));
vi.mock("../src/cli/commands/setup.js", () => ({ setupCommand }));

async function importCli(argv: string[]) {
  vi.resetModules();
  process.argv = ["node", "src/cli/index.ts", ...argv];
  await import("../src/cli/index.ts");
}

function rmTestDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 250 });
  } catch (err) {
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EBUSY") return;
    throw err;
  }
}

describe("bare CLI routing", () => {
  let home: string;
  let cwd: string;
  const origHome = process.env["HOME"];
  const origUserProfile = process.env["USERPROFILE"];
  const origArgv = process.argv;
  const origCwd = process.cwd();
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-cli-home-"));
    // macOS's tmpdir is /var/folders/... but realpath is /private/var/folders/...;
    // process.chdir followed by process.cwd() returns the resolved form, so
    // normalise here too or the toHaveBeenCalledWith({ dir: cwd, ... }) assertions
    // compare mismatched paths.
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "reasonix-cli-cwd-")));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    process.chdir(cwd);
    codeCommand.mockClear();
    codeRemoteCommand.mockClear();
    chatCommand.mockClear();
    setupCommand.mockClear();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    process.chdir(origCwd);
    process.argv = origArgv;
    rmTestDir(home);
    rmTestDir(cwd);
    if (origHome === undefined) {
      // biome-ignore lint/performance/noDelete: env restoration needs absence, not "undefined"
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = origHome;
    }
    if (origUserProfile === undefined) {
      // biome-ignore lint/performance/noDelete: env restoration needs absence, not "undefined"
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = origUserProfile;
    }
  });

  it("routes bare reasonix to the daemon thin client rooted at cwd", async () => {
    writeConfig({ setupCompleted: true }, join(home, ".reasonix", "config.json"));
    mkdirSync(join(cwd, ".git"));

    await importCli([]);

    // Daemon-first: bare reasonix is the daemon thin client, not the in-process TUI.
    await vi.waitFor(() => expect(codeRemoteCommand).toHaveBeenCalledWith({ cwd }));
    expect(codeCommand).not.toHaveBeenCalled();
    expect(chatCommand).not.toHaveBeenCalled();
  });

  it("routes bare reasonix in a non-project directory to the daemon too", async () => {
    writeConfig({ setupCompleted: true }, join(home, ".reasonix", "config.json"));

    await importCli([]);

    await vi.waitFor(() => expect(codeRemoteCommand).toHaveBeenCalledWith({ cwd }));
    expect(chatCommand).not.toHaveBeenCalled();
  });

  it("routes `code --local` to the rich in-process TUI", async () => {
    writeConfig({ setupCompleted: true }, join(home, ".reasonix", "config.json"));

    await importCli(["code", "--local"]);

    await vi.waitFor(() => expect(codeCommand).toHaveBeenCalled());
    expect(codeRemoteCommand).not.toHaveBeenCalled();
  });

  it("routes `code` (no flag) to the daemon thin client", async () => {
    writeConfig({ setupCompleted: true }, join(home, ".reasonix", "config.json"));

    await importCli(["code"]);

    await vi.waitFor(() => expect(codeRemoteCommand).toHaveBeenCalled());
    expect(codeCommand).not.toHaveBeenCalled();
  });

  it("keeps explicit reasonix chat in chat mode even inside a project", async () => {
    writeConfig({ setupCompleted: true }, join(home, ".reasonix", "config.json"));
    writeFileSync(join(cwd, "package.json"), "{}\n", "utf8");

    await importCli(["chat"]);

    await vi.waitFor(() => expect(chatCommand).toHaveBeenCalled());
    expect(codeCommand).not.toHaveBeenCalled();
  });

  it("keeps first-run bare reasonix on the setup wizard", async () => {
    writeConfig({ setupCompleted: false }, join(home, ".reasonix", "config.json"));
    mkdirSync(join(cwd, ".git"));

    await importCli([]);

    await vi.waitFor(() => expect(setupCommand).toHaveBeenCalledWith({ forceKeyStep: true }));
    expect(codeCommand).not.toHaveBeenCalled();
    expect(chatCommand).not.toHaveBeenCalled();
  });
});

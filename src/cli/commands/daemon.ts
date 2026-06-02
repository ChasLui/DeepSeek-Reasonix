/** `reasonix daemon` — run the OS-managed session host and the `run --remote` thin client. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadApiKey } from "../../config.js";
import { connectDaemon } from "../../daemon/client.js";
import { DaemonHost } from "../../daemon/host.js";
import { resolvePermissionInteractively } from "../../daemon/permission-prompt.js";
import { listenDaemon } from "../../daemon/server-listen.js";
import {
  LAUNCHD_LABEL,
  daemonLogPath,
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitPath,
} from "../../daemon/service-files.js";
import {
  isAlive,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from "../../daemon/state.js";
import { loadDotenv } from "../../env.js";
import type { LoopEvent } from "../../loop/types.js";
import { daemonSocketPath } from "../../storage/path.js";
import { VERSION } from "../../version.js";
import { resolveDir } from "./acp.js";

export interface DaemonRunOptions {
  dir?: string;
  model?: string;
  budgetUsd?: number;
  yolo?: boolean;
  mcpSpecs?: string[];
  mcpPrefix?: string;
  socketPath?: string;
}

function clearStaleSocket(socketPath: string): void {
  const state = readDaemonState();
  if (state && isAlive(state.pid)) {
    throw new Error(`daemon already running (pid ${state.pid}) on ${state.socket}`);
  }
  // No live daemon — clear leftovers so bind() doesn't hit EADDRINUSE.
  removeDaemonState();
  if (process.platform !== "win32" && existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }
}

export async function daemonRunCommand(opts: DaemonRunOptions): Promise<void> {
  loadDotenv();
  const key = loadApiKey();
  if (key) process.env.DEEPSEEK_API_KEY = key;

  const socketPath = opts.socketPath ?? daemonSocketPath();
  clearStaleSocket(socketPath);
  const defaultDir = resolveDir(opts.dir, process.cwd());

  const host = new DaemonHost({
    defaultDir,
    model: opts.model,
    budgetUsd: opts.budgetUsd,
    yolo: opts.yolo,
    mcpSpecs: opts.mcpSpecs,
    mcpPrefix: opts.mcpPrefix,
  });
  host.start();
  const server = await listenDaemon(host, socketPath);
  writeDaemonState({
    pid: process.pid,
    socket: socketPath,
    version: VERSION,
    startedAt: new Date().toISOString(),
  });
  process.stderr.write(`reasonix daemon listening on ${socketPath} (pid ${process.pid})\n`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await host.closeAll();
    removeDaemonState();
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
    // Let the SQLite exit-checkpoint hook fire on a clean exit.
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Block until a signal triggers shutdown.
  await new Promise<void>(() => {});
}

export interface RunRemoteOptions {
  task: string;
  cwd?: string;
  socketPath?: string;
}

function renderRemoteEvent(ev: LoopEvent): void {
  if (ev.role === "assistant_delta" && ev.content) process.stdout.write(ev.content);
  else if (ev.role === "tool") process.stdout.write(`\n[tool ${ev.toolName}] ${ev.content}\n`);
  else if (ev.role === "error") process.stderr.write(`\n[error] ${ev.error ?? ev.content}\n`);
  else if (ev.role === "done") process.stdout.write("\n");
}

/** Interactive confirmation handler — only when both ends are a TTY; otherwise omitted so the daemon fails closed (deny). */
function interactivePermission():
  | ((
      params: import("../../acp/protocol.js").PermissionRequestParams,
    ) => Promise<import("../../acp/protocol.js").PermissionRequestResult>)
  | undefined {
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return async (params) => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await resolvePermissionInteractively(params, {
        write: (text) => void stdout.write(text),
        ask: (query) => rl.question(query),
      });
    } finally {
      rl.close();
    }
  };
}

export async function runRemoteCommand(opts: RunRemoteOptions): Promise<void> {
  const socketPath = opts.socketPath ?? daemonSocketPath();
  let client: Awaited<ReturnType<typeof connectDaemon>>;
  try {
    client = await connectDaemon(socketPath, {
      onPermission: interactivePermission(),
    });
  } catch {
    process.stderr.write(
      `daemon not reachable at ${socketPath}. Start it with:  reasonix daemon start\n`,
    );
    process.exit(1);
  }
  try {
    await client.initialize();
    const sessionId = await client.newSession(resolve(opts.cwd ?? process.cwd()));
    const stopReason = await client.prompt(sessionId, opts.task, renderRemoteEvent);
    if (stopReason === "error") process.exitCode = 1;
  } finally {
    client.close();
  }
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function run(cmd: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, stderr: r.stderr ?? "" };
}

function serviceTarget(): { node: string; cli: string; logPath: string } {
  return {
    node: process.execPath,
    cli: process.argv[1] ?? "",
    logPath: daemonLogPath(),
  };
}

export async function daemonInstallCommand(): Promise<void> {
  const target = serviceTarget();
  if (isMac()) {
    const path = launchdPlistPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderLaunchdPlist(target));
    // bootout first so a re-install picks up the new plist (idempotent).
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    const res = run("launchctl", ["bootstrap", `gui/${uid}`, path]);
    if (!res.ok) {
      process.stderr.write(`launchctl bootstrap failed: ${res.stderr.trim()}\n`);
      process.exit(1);
    }
    process.stdout.write(`installed launchd service → ${path}\n`);
    return;
  }
  if (isLinux()) {
    const path = systemdUnitPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSystemdUnit(target));
    run("systemctl", ["--user", "daemon-reload"]);
    const res = run("systemctl", ["--user", "enable", "--now", "reasonix.service"]);
    if (!res.ok) {
      process.stderr.write(`systemctl enable failed: ${res.stderr.trim()}\n`);
      process.exit(1);
    }
    process.stdout.write(`installed systemd user service → ${path}\n`);
    return;
  }
  process.stderr.write(
    "daemon install is only supported on macOS (launchd) and Linux (systemd).\n",
  );
  process.exit(1);
}

export async function daemonUninstallCommand(): Promise<void> {
  if (isMac()) {
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    rmSync(launchdPlistPath(), { force: true });
    process.stdout.write("uninstalled launchd service\n");
    return;
  }
  if (isLinux()) {
    run("systemctl", ["--user", "disable", "--now", "reasonix.service"]);
    rmSync(systemdUnitPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    process.stdout.write("uninstalled systemd user service\n");
    return;
  }
  process.stderr.write("daemon uninstall is only supported on macOS and Linux.\n");
  process.exit(1);
}

function serviceInstalled(): boolean {
  if (isMac()) return existsSync(launchdPlistPath());
  if (isLinux()) return existsSync(systemdUnitPath());
  return false;
}

export async function daemonStartCommand(): Promise<void> {
  if (!serviceInstalled()) {
    process.stderr.write(
      "no service installed — run `reasonix daemon install`, or `reasonix daemon run` for a foreground daemon.\n",
    );
    process.exit(1);
  }
  if (isMac()) {
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["kickstart", `gui/${uid}/${LAUNCHD_LABEL}`]);
  } else {
    run("systemctl", ["--user", "start", "reasonix.service"]);
  }
  process.stdout.write("daemon started\n");
}

export async function daemonStopCommand(): Promise<void> {
  // An installed service must be stopped through its supervisor, otherwise
  // KeepAlive/Restart relaunches it immediately. A bare foreground `daemon run`
  // has no supervisor — signal its pid from the state file instead.
  if (serviceInstalled()) {
    if (isMac()) {
      const uid = process.getuid?.() ?? 0;
      run("launchctl", ["kill", "SIGTERM", `gui/${uid}/${LAUNCHD_LABEL}`]);
    } else {
      run("systemctl", ["--user", "stop", "reasonix.service"]);
    }
    process.stdout.write("daemon stop signalled\n");
    return;
  }
  const state = readDaemonState();
  if (state && isAlive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    process.stdout.write(`daemon stop signalled (pid ${state.pid})\n`);
    return;
  }
  process.stdout.write("daemon: not running\n");
}

export async function daemonStatusCommand(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    process.stdout.write("daemon: not running (no state file)\n");
    return;
  }
  const alive = isAlive(state.pid);
  process.stdout.write(
    `daemon: ${alive ? "running" : "stale"}  pid=${state.pid}  socket=${state.socket}  version=${state.version}  since=${state.startedAt}\n`,
  );
  if (!alive) {
    process.stdout.write("  (pid not alive — run `reasonix daemon start` to relaunch)\n");
    return;
  }
  try {
    const client = await connectDaemon(state.socket);
    try {
      const pong = await client.ping();
      process.stdout.write(`  ping ok — ${pong.sessions} active session(s)\n`);
    } finally {
      client.close();
    }
  } catch {
    process.stdout.write("  ping failed — socket unresponsive\n");
  }
}

export async function daemonLogsCommand(): Promise<void> {
  const path = daemonLogPath();
  if (!existsSync(path)) {
    process.stdout.write(`no daemon log yet at ${path}\n`);
    return;
  }
  const r = spawnSync("tail", ["-n", "100", "-f", path], { stdio: "inherit" });
  if (r.error) process.stdout.write(`log file: ${path}\n`);
}

/** `reasonix daemon` — run the OS-managed session host and the `run --remote` thin client. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadApiKey } from "../../config.js";
import { connectDaemon } from "../../daemon/client.js";
import { ensureDaemon } from "../../daemon/ensure.js";
import { DaemonHost } from "../../daemon/host.js";
import { resolvePermissionInteractively } from "../../daemon/permission-prompt.js";
import { renderSessionUpdate } from "../../daemon/render-update.js";
import { listenDaemon } from "../../daemon/server-listen.js";
import {
  LAUNCHD_LABEL,
  daemonLogPath,
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdSocket,
  renderSystemdSocketService,
  systemdSocketPath,
  systemdUnitPath,
} from "../../daemon/service-files.js";
import { inheritedListenFd } from "../../daemon/socket-activation.js";
import {
  isAlive,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from "../../daemon/state.js";
import { startStatusServer } from "../../daemon/status-server.js";
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
  /** Idle-shutdown window in ms. Flag wins over REASONIX_DAEMON_IDLE_MS; 0/absent stays up forever. */
  idleMs?: number;
  /** Loopback HTTP status port (GET /health, /status). Flag > REASONIX_DAEMON_HTTP_PORT; absent disables. */
  httpPort?: number;
  /** Enable Pillar 5 background index maintenance. Flag > REASONIX_BG_INDEX; opt-in (watchers + rebuilds cost CPU/IO). */
  backgroundIndex?: boolean;
}

/** Flag > env > disabled. Non-positive / malformed → disabled (stay up). */
function resolveIdleMs(flag: number | undefined): number | undefined {
  const raw = flag ?? Number.parseInt(process.env.REASONIX_DAEMON_IDLE_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Flag > env > disabled. Out-of-range → disabled. */
function resolveHttpPort(flag: number | undefined): number | undefined {
  const raw = flag ?? Number.parseInt(process.env.REASONIX_DAEMON_HTTP_PORT ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : undefined;
}

/** Flag > env. Pillar 5 background indexing — opt-in (fs watchers + background rebuilds cost CPU/IO). */
function resolveBackgroundIndex(flag: boolean | undefined): boolean {
  if (flag !== undefined) return flag;
  return /^(1|true|yes|on)$/i.test(process.env.REASONIX_BG_INDEX ?? "");
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
  // Under systemd socket activation the socket is created + owned by systemd;
  // we must neither unlink a "stale" one nor bind our own.
  const activated = inheritedListenFd() !== null;
  if (!activated) clearStaleSocket(socketPath);
  const defaultDir = resolveDir(opts.dir, process.cwd());

  const idleMs = resolveIdleMs(opts.idleMs);
  const host = new DaemonHost({
    defaultDir,
    model: opts.model,
    budgetUsd: opts.budgetUsd,
    yolo: opts.yolo,
    mcpSpecs: opts.mcpSpecs,
    mcpPrefix: opts.mcpPrefix,
    idleMs,
    backgroundIndex: resolveBackgroundIndex(opts.backgroundIndex),
    // Reuse the SIGTERM path so idle shutdown drains MCP + checkpoints SQLite.
    onIdle: () => {
      process.stderr.write(`reasonix daemon idle for ${idleMs}ms — shutting down\n`);
      process.kill(process.pid, "SIGTERM");
    },
  });
  host.start();
  const server = await listenDaemon(host, socketPath);
  const startedAtMs = Date.now();
  const httpPort = resolveHttpPort(opts.httpPort);
  const statusServer =
    httpPort !== undefined ? await startStatusServer(host, httpPort, startedAtMs) : null;
  if (statusServer) {
    const addr = statusServer.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : httpPort;
    process.stderr.write(`reasonix daemon status on http://127.0.0.1:${boundPort}/status\n`);
  }
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
    statusServer?.close();
    await host.closeAll();
    removeDaemonState();
    // Don't remove a systemd-owned socket; only our self-bound one.
    if (!activated && process.platform !== "win32") rmSync(socketPath, { force: true });
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
    await ensureDaemon(socketPath);
    client = await connectDaemon(socketPath, {
      onPermission: interactivePermission(),
    });
  } catch (err) {
    process.stderr.write(`could not reach or start the daemon: ${(err as Error).message}\n`);
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

export interface AttachOptions {
  cwd?: string;
  socketPath?: string;
}

/** Interactive multi-turn thin client over the daemon: renders the kernel-event stream and resolves confirmations on the same readline (no stdin contention). */
export async function attachRemoteCommand(opts: AttachOptions): Promise<void> {
  const socketPath = opts.socketPath ?? daemonSocketPath();
  const rl = createInterface({ input: stdin, output: stdout });
  // One shared readline: the prompt loop only reads between turns, and gate
  // prompts only fire mid-turn — never concurrently — so they can share it.
  let client: Awaited<ReturnType<typeof connectDaemon>>;
  try {
    await ensureDaemon(socketPath);
    client = await connectDaemon(socketPath, {
      onUpdate: (p) => renderSessionUpdate(p.update, { write: (t) => void stdout.write(t) }),
      onPermission: async (params) =>
        resolvePermissionInteractively(params, {
          write: (t) => void stdout.write(t),
          ask: (q) => rl.question(q),
        }),
    });
  } catch (err) {
    rl.close();
    process.stderr.write(`could not reach or start the daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
  try {
    await client.initialize();
    const sessionId = await client.newSession(resolve(opts.cwd ?? process.cwd()));
    process.stdout.write(
      `attached to daemon session ${sessionId} — type a prompt (Ctrl-D to exit)\n`,
    );
    while (true) {
      let line: string;
      try {
        line = (await rl.question("\n› ")).trim();
      } catch {
        break; // stream closed (Ctrl-D)
      }
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      // Rendering happens via onUpdate; the loopEvent callback is unused here.
      await client.prompt(sessionId, line, () => undefined);
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
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

function launchdService(): string {
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

function launchdServiceLoaded(): boolean {
  return run("launchctl", ["print", launchdService()]).ok;
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
    run("launchctl", ["bootout", launchdService()]);
    const uid = process.getuid?.() ?? 0;
    const res = run("launchctl", ["bootstrap", `gui/${uid}`, path]);
    if (!res.ok) {
      process.stderr.write(`launchctl bootstrap failed: ${res.stderr.trim()}\n`);
      process.exit(1);
    }
    process.stdout.write(`installed launchd service → ${path}\n`);
    return;
  }
  if (isLinux()) {
    // Socket-activated: systemd binds the socket and starts the service on the
    // first connection; idle-shutdown lets it exit and re-activate on demand.
    const IDLE_MS = 1_800_000; // 30 min
    mkdirSync(dirname(systemdUnitPath()), { recursive: true });
    writeFileSync(systemdSocketPath(), renderSystemdSocket(daemonSocketPath()));
    writeFileSync(systemdUnitPath(), renderSystemdSocketService(target, IDLE_MS));
    run("systemctl", ["--user", "daemon-reload"]);
    const res = run("systemctl", ["--user", "enable", "--now", "reasonix.socket"]);
    if (!res.ok) {
      process.stderr.write(`systemctl enable failed: ${res.stderr.trim()}\n`);
      process.exit(1);
    }
    process.stdout.write(`installed socket-activated systemd service → ${systemdSocketPath()}\n`);
    return;
  }
  process.stderr.write(
    "daemon install is only supported on macOS (launchd) and Linux (systemd).\n",
  );
  process.exit(1);
}

export async function daemonUninstallCommand(): Promise<void> {
  if (isMac()) {
    run("launchctl", ["bootout", launchdService()]);
    rmSync(launchdPlistPath(), { force: true });
    process.stdout.write("uninstalled launchd service\n");
    return;
  }
  if (isLinux()) {
    run("systemctl", ["--user", "disable", "--now", "reasonix.socket"]);
    run("systemctl", ["--user", "stop", "reasonix.service"]);
    rmSync(systemdSocketPath(), { force: true });
    rmSync(systemdUnitPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    process.stdout.write("uninstalled socket-activated systemd service\n");
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
    if (!launchdServiceLoaded()) {
      const uid = process.getuid?.() ?? 0;
      const res = run("launchctl", ["bootstrap", `gui/${uid}`, launchdPlistPath()]);
      if (!res.ok) {
        process.stderr.write(`launchctl bootstrap failed: ${res.stderr.trim()}\n`);
        process.exit(1);
      }
    }
    const res = run("launchctl", ["kickstart", launchdService()]);
    if (!res.ok) {
      process.stderr.write(`launchctl kickstart failed: ${res.stderr.trim()}\n`);
      process.exit(1);
    }
  } else {
    // Starting the socket arms socket activation; the service spawns on connect.
    run("systemctl", ["--user", "start", "reasonix.socket"]);
  }
  process.stdout.write("daemon started\n");
}

export async function daemonStopCommand(): Promise<void> {
  // An installed service must be stopped through its supervisor, otherwise
  // KeepAlive/Restart relaunches it immediately. A bare foreground `daemon run`
  // has no supervisor — signal its pid from the state file instead.
  if (serviceInstalled()) {
    if (isMac()) {
      run("launchctl", ["bootout", launchdService()]);
    } else {
      // Stop the socket too, else the next connection re-activates the service.
      run("systemctl", ["--user", "stop", "reasonix.socket", "reasonix.service"]);
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

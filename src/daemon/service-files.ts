/** Render + locate the OS service definitions (launchd plist / systemd user unit) that keep the daemon running. */

import { homedir } from "node:os";
import { join } from "node:path";
import { reasonixDir } from "../storage/path.js";

export const LAUNCHD_LABEL = "com.reasonix.daemon";
export const SYSTEMD_UNIT = "reasonix.service";

export interface ServiceTarget {
  /** Node binary that runs the CLI (process.execPath). */
  node: string;
  /** CLI entry script (process.argv[1]). */
  cli: string;
  logPath: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderLaunchdPlist(target: ServiceTarget): string {
  const args = [target.node, target.cli, "daemon", "run"]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(target.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(target.logPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(target: ServiceTarget): string {
  return `[Unit]
Description=Reasonix daemon
After=network.target

[Service]
ExecStart=${target.node} ${target.cli} daemon run
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

export function daemonLogPath(): string {
  return join(reasonixDir(), "daemon.log");
}

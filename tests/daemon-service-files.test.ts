/** Daemon service-file renderers (byte-stable) + liveness probe. */

import { describe, expect, it } from "vitest";
import {
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdSocket,
  renderSystemdSocketService,
  renderSystemdUnit,
} from "../src/daemon/service-files.js";
import { inheritedListenFd } from "../src/daemon/socket-activation.js";
import { isAlive } from "../src/daemon/state.js";

const TARGET = {
  node: "/usr/bin/node",
  cli: "/opt/reasonix/cli.js",
  logPath: "/home/u/.reasonix/daemon.log",
};

describe("daemon service-file renderers", () => {
  it("renders a launchd plist with KeepAlive and the run args", () => {
    const plist = renderLaunchdPlist(TARGET);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>/opt/reasonix/cli.js</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>/home/u/.reasonix/daemon.log</string>");
  });

  it("escapes XML-special characters in paths", () => {
    const plist = renderLaunchdPlist({ ...TARGET, cli: "/opt/a&b/cli.js" });
    expect(plist).toContain("/opt/a&amp;b/cli.js");
    expect(plist).not.toContain("/opt/a&b/cli.js");
  });

  it("renders a systemd user unit with Restart=always", () => {
    const unit = renderSystemdUnit(TARGET);
    expect(unit).toContain("Description=Reasonix daemon");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/reasonix/cli.js daemon run");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("daemon liveness probe", () => {
  it("reports the current process as alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("reports a non-existent pid as dead", () => {
    // 2^30 is far above any real pid on supported platforms.
    expect(isAlive(2 ** 30)).toBe(false);
  });
});

describe("systemd socket activation (Slice 5)", () => {
  it("renders a .socket unit binding the daemon socket at mode 0600", () => {
    const sock = renderSystemdSocket("/home/u/.reasonix/daemon.sock");
    expect(sock).toContain("ListenStream=/home/u/.reasonix/daemon.sock");
    expect(sock).toContain("SocketMode=0600");
    expect(sock).toContain("WantedBy=sockets.target");
  });

  it("renders a socket-activated service with idle-shutdown and no self-bind", () => {
    const svc = renderSystemdSocketService(TARGET, 1800000);
    expect(svc).toContain(
      "ExecStart=/usr/bin/node /opt/reasonix/cli.js daemon run --idle-ms 1800000",
    );
    expect(svc).toContain("Requires=reasonix.socket");
    expect(svc).not.toContain("WantedBy=");
  });

  it("detects an inherited listen fd only when LISTEN_FDS is set for this pid", () => {
    expect(inheritedListenFd({})).toBeNull();
    expect(inheritedListenFd({ LISTEN_FDS: "1", LISTEN_PID: String(process.pid) })).toBe(3);
    // Leaked to a child: LISTEN_PID points elsewhere → ignore.
    expect(inheritedListenFd({ LISTEN_FDS: "1", LISTEN_PID: "999999" })).toBeNull();
    expect(inheritedListenFd({ LISTEN_FDS: "0" })).toBeNull();
  });
});

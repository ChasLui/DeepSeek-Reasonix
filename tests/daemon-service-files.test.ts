/** Daemon service-file renderers (byte-stable) + liveness probe. */

import { describe, expect, it } from "vitest";
import {
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "../src/daemon/service-files.js";
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

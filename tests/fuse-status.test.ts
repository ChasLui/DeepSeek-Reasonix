import { describe, expect, it } from "vitest";
import { getFuseStatus, resolveFuseMode } from "../src/fuse/status.js";

describe("resolveFuseMode", () => {
  it("defaults to the FUSE path", () => {
    expect(resolveFuseMode({})).toBe("default");
  });

  it("honors off and required env modes", () => {
    expect(resolveFuseMode({ REASONIX_FUSE: "0" })).toBe("off");
    expect(resolveFuseMode({ REASONIX_FUSE: "off" })).toBe("off");
    expect(resolveFuseMode({ REASONIX_FUSE: "required" })).toBe("required");
    expect(resolveFuseMode({ REASONIX_FUSE: "1" })).toBe("default");
  });
});

describe("getFuseStatus", () => {
  it("reports disabled when the FUSE path is explicitly off", () => {
    expect(getFuseStatus({ env: { REASONIX_FUSE: "0" }, platform: "darwin" })).toMatchObject({
      mode: "off",
      state: "disabled",
      detail: "disabled via REASONIX_FUSE=0",
    });
  });

  it("detects macFUSE markers on macOS", () => {
    const status = getFuseStatus({
      platform: "darwin",
      existsSync: (path) => path === "/Library/Filesystems/macfuse.fs",
    });

    expect(status).toMatchObject({
      mode: "default",
      state: "ready",
      detail: "FUSE capability detected",
    });
  });

  it("degrades to direct filesystem fallback when macFUSE is missing in default mode", () => {
    const status = getFuseStatus({
      platform: "darwin",
      existsSync: () => false,
      path: "",
    });

    expect(status).toMatchObject({
      mode: "default",
      state: "degraded",
    });
    expect(status.detail).toContain("macFUSE not detected");
    expect(status.detail).toContain("direct filesystem fallback");
  });

  it("fails capability status when FUSE is required but missing", () => {
    const status = getFuseStatus({
      env: { REASONIX_FUSE: "required" },
      platform: "linux",
      existsSync: () => false,
      canAccess: () => false,
    });

    expect(status).toMatchObject({
      mode: "required",
      state: "unsupported",
    });
    expect(status.detail).toContain("FUSE is required");
  });

  it("requires both /dev/fuse and fusermount3 on Linux", () => {
    const status = getFuseStatus({
      platform: "linux",
      existsSync: (path) => path === "/bin/fusermount3",
      canAccess: (path) => path === "/dev/fuse",
      path: "/bin",
    });

    expect(status).toMatchObject({
      mode: "default",
      state: "ready",
    });
  });
});

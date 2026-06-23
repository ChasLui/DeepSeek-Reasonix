import { accessSync, existsSync } from "node:fs";
import { delimiter } from "node:path";

export type FuseMode = "default" | "required" | "off";
export type FuseState = "ready" | "degraded" | "disabled" | "unsupported";

export interface FuseStatus {
  mode: FuseMode;
  state: FuseState;
  platform: NodeJS.Platform;
  detail: string;
}

interface ProbeDeps {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  existsSync?: ((path: string) => boolean) | undefined;
  canAccess?: ((path: string) => boolean) | undefined;
  path?: string | undefined;
}

const MACFUSE_MARKERS = [
  "/Library/Filesystems/macfuse.fs",
  "/Library/Filesystems/osxfuse.fs",
  "/usr/local/bin/mount_macfuse",
  "/opt/homebrew/bin/mount_macfuse",
] as const;

export function resolveFuseMode(env: NodeJS.ProcessEnv = process.env): FuseMode {
  const raw = env["REASONIX_FUSE"]?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
  if (raw === "required" || raw === "require") return "required";
  return "default";
}

export function getFuseStatus(deps: ProbeDeps = {}): FuseStatus {
  const platform = deps.platform ?? process.platform;
  const mode = resolveFuseMode(deps.env);
  if (mode === "off") {
    return {
      mode,
      state: "disabled",
      platform,
      detail: "disabled via REASONIX_FUSE=0",
    };
  }

  const ready = hasFuseCapability({
    platform,
    exists: deps.existsSync ?? existsSync,
    canAccess: deps.canAccess ?? canAccessPath,
    path: deps.path ?? deps.env?.["PATH"] ?? process.env["PATH"] ?? "",
  });
  if (ready) {
    return {
      mode,
      state: "ready",
      platform,
      detail: "FUSE capability detected",
    };
  }

  if (platform !== "darwin" && platform !== "linux") {
    return {
      mode,
      state: "unsupported",
      platform,
      detail:
        mode === "required"
          ? `FUSE is required but unsupported on ${platform}`
          : `FUSE default path is unsupported on ${platform}; using direct filesystem fallback`,
    };
  }

  const dependency = platform === "darwin" ? "macFUSE" : "fuse3 and /dev/fuse";
  return {
    mode,
    state: mode === "required" ? "unsupported" : "degraded",
    platform,
    detail:
      mode === "required"
        ? `${dependency} not detected; FUSE is required`
        : `${dependency} not detected; using direct filesystem fallback`,
  };
}

function hasFuseCapability(opts: {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  canAccess: (path: string) => boolean;
  path: string;
}): boolean {
  if (opts.platform === "darwin") {
    if (MACFUSE_MARKERS.some((p) => opts.exists(p))) return true;
    return commandOnPath("mount_macfuse", opts.path, opts.exists);
  }
  if (opts.platform === "linux") {
    if (!opts.canAccess("/dev/fuse")) return false;
    return commandOnPath("fusermount3", opts.path, opts.exists);
  }
  return false;
}

function commandOnPath(
  command: string,
  pathValue: string,
  exists: (path: string) => boolean,
): boolean {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exists(`${dir}/${command}`));
}

function canAccessPath(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

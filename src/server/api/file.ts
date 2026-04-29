/** `/api/file[s]` — every path is sandboxed against getCurrentCwd(); escapes return 403, binaries return 415. */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { listFilesSync } from "../../at-mentions.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB; UI editor isn't built for huge buffers
const BINARY_PROBE_BYTES = 8 * 1024;

interface WriteBody {
  content?: unknown;
}

function parseBody(raw: string): WriteBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as WriteBody) : {};
  } catch {
    return {};
  }
}

/** Returns null when resolution escapes `root` — catches `..`, drive-letter differences, etc. */
function safeResolve(root: string, requested: string): string | null {
  const rootAbs = resolve(root);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(rootAbs, requested);
  // Allow target === root (read-listing case) but anything else must be
  // strictly under it via the path-separator boundary check; otherwise
  // `proj` and `project-mate` would both pass a naive startsWith.
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

function looksBinary(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const len = readSync(fd, buf, 0, BINARY_PROBE_BYTES, 0);
    for (let i = 0; i < len; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function handleFiles(
  method: string,
  _rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const cwd = ctx.getCurrentCwd?.();
  if (!cwd) {
    return {
      status: 503,
      body: { error: "no project root — open `/dashboard` from `reasonix code`" },
    };
  }
  // Cap the listing so a giant repo doesn't blow up the response.
  const files = listFilesSync(cwd, { maxResults: 5000 });
  return {
    status: 200,
    body: {
      root: cwd,
      count: files.length,
      truncated: files.length === 5000,
      files,
    },
  };
}

export async function handleFile(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  const cwd = ctx.getCurrentCwd?.();
  if (!cwd) {
    return { status: 503, body: { error: "no project root" } };
  }
  const requested = rest.map((s) => decodeURIComponent(s)).join("/");
  if (!requested) {
    return { status: 400, body: { error: "path required (use /api/file/<path>)" } };
  }
  const target = safeResolve(cwd, requested);
  if (!target) {
    return { status: 403, body: { error: "path escapes project root" } };
  }

  if (method === "GET") {
    if (!existsSync(target)) {
      return { status: 404, body: { error: "file not found" } };
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      return { status: 400, body: { error: "path is a directory" } };
    }
    if (stat.size > MAX_BYTES) {
      return {
        status: 413,
        body: { error: `file too large (${stat.size} bytes; cap ${MAX_BYTES})` },
      };
    }
    if (looksBinary(target)) {
      return {
        status: 415,
        body: { error: "file appears to be binary — editor refuses to load." },
      };
    }
    const content = readFileSync(target, "utf8");
    return {
      status: 200,
      body: {
        path: requested,
        absolute: target,
        size: stat.size,
        mtime: stat.mtime.getTime(),
        content,
      },
    };
  }

  if (method === "POST") {
    const { content } = parseBody(body);
    if (typeof content !== "string") {
      return { status: 400, body: { error: "content (string) required" } };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
      return { status: 413, body: { error: "content exceeds 4 MB cap" } };
    }
    // Refuse to overwrite a directory; refuse to create above project.
    if (existsSync(target) && statSync(target).isDirectory()) {
      return { status: 400, body: { error: "path is a directory" } };
    }
    // Ensure parent dir exists. We allow creating new files inside any
    // existing-or-creatable subtree under the project root.
    const parent = dirname(target);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(target, content, "utf8");
    ctx.audit?.({
      ts: Date.now(),
      action: "save-file",
      payload: { path: requested, bytes: Buffer.byteLength(content, "utf8") },
    });
    const stat = statSync(target);
    return {
      status: 200,
      body: {
        saved: true,
        path: requested,
        size: stat.size,
        mtime: stat.mtime.getTime(),
      },
    };
  }

  return { status: 405, body: { error: "GET or POST only" } };
}

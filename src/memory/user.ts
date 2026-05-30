/** User-private memory pinned into the immutable prefix; distinct from committable REASONIX.md. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteMemoryStore } from "../adapters/memory-store-sqlite.js";
import {
  type ReasonixConfig,
  type ToonMode,
  loadResolvedSkillPaths,
  memoryTypeDefaults,
  resolveSkillPaths,
} from "../config.js";
import { applySkillsIndex } from "../skills.js";
import { getDb } from "../storage/db.js";
import { formatPromptPayloadBlock, toonPrefixEnabled } from "../toon/prompt-payload.js";
import { applyProjectMemory, memoryEnabled } from "./project.js";

export const USER_MEMORY_DIR = "memory";
export const MEMORY_INDEX_FILE = "MEMORY.md";
/** Cap on the index file content loaded into the prefix, per scope. */
export const MEMORY_INDEX_MAX_CHARS = 4000;

export const BUILTIN_MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type BuiltinMemoryType = (typeof BUILTIN_MEMORY_TYPES)[number];
/** Built-ins plus any string declared in `config.memory.customTypes`. Unknown values are accepted (round-tripped verbatim). */
export type MemoryType = BuiltinMemoryType | (string & {});
export type MemoryScope = "global" | "project";
export type MemoryPriority = "low" | "medium" | "high";
export type MemoryExpires = "project_end";

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  description: string;
  body: string;
  /** ISO date string (YYYY-MM-DD). */
  createdAt: string;
  /** Explicit per-entry priority; absent → resolve from config default for `type`, else "medium". */
  priority?: MemoryPriority;
  /** Lifecycle hint. `project_end` → cleared by `/memory clear project`. */
  expires?: MemoryExpires;
}

export interface MemoryStoreOptions {
  /** Override `~/.reasonix` — tests set this to a tmpdir. */
  homeDir?: string;
  /** Absolute sandbox root. Required to use `scope: "project"`. */
  projectRoot?: string;
}

export interface WriteInput {
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  description: string;
  body: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
}

const VALID_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{1,38}[a-zA-Z0-9]$/;

/** Throws on path-injection (../, /, leading dot). Allowed: 3-40 chars, alnum/_/-, interior `.`. */
export function sanitizeMemoryName(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!VALID_NAME.test(trimmed)) {
    throw new Error(
      `invalid memory name: ${JSON.stringify(raw)} — must be 3-40 chars, alnum/_/-, no path separators`,
    );
  }
  return trimmed;
}

/** Stable 16-hex-char hash of an absolute sandbox root path. */
export function projectHash(rootDir: string): string {
  const abs = resolve(rootDir);
  return createHash("sha1").update(abs).digest("hex").slice(0, 16);
}

// SQLite-only factory: every memory read/write site builds its store through this, so the
// prefix READ path (applyUserMemory) and all WRITE paths share one backend (split-brain P0
// fix). `homeDir` only locates on-disk sidecars; memory content lives in the shared db.
export function openMemoryStore(opts: MemoryStoreOptions = {}): SqliteMemoryStore {
  return new SqliteMemoryStore(getDb(), opts.projectRoot, opts.homeDir);
}

/** Freeform `#g` destination, distinct from MEMORY.md's curated index of named files. */
export function readGlobalReasonixMemory(homeDir: string = join(homedir(), ".reasonix")): {
  path: string;
  content: string;
  originalChars: number;
  truncated: boolean;
} | null {
  const path = join(homeDir, "REASONIX.md");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const originalChars = trimmed.length;
  // Reuse the project-memory cap so both freeform files have the same
  // headroom (8000 chars ≈ 2k tokens). They serve the same purpose at
  // different scopes.
  const truncated = originalChars > 8000;
  const content = truncated
    ? `${trimmed.slice(0, 8000)}\n… (truncated ${originalChars - 8000} chars)`
    : trimmed;
  return { path, content, originalChars, truncated };
}

export function applyGlobalReasonixMemory(basePrompt: string, homeDir?: string): string {
  if (!memoryEnabled()) return basePrompt;
  const dir = homeDir ?? join(homedir(), ".reasonix");
  const mem = readGlobalReasonixMemory(dir);
  if (!mem) return basePrompt;
  return [
    basePrompt,
    "",
    "# Global memory (~/.reasonix/REASONIX.md)",
    "",
    "Cross-project notes the user pinned via the `#g` prompt prefix. Treat as authoritative — same level of trust as project memory.",
    "",
    "```",
    mem.content,
    "```",
  ].join("\n");
}

/** Effective priority: entry's own field wins, else the config default for its type, else undefined. */
export function effectivePriority(
  entry: MemoryEntry,
  cfg?: ReasonixConfig,
): MemoryPriority | undefined {
  if (entry.priority) return entry.priority;
  return memoryTypeDefaults(entry.type, cfg).priority;
}

function highPriorityBlock(entries: MemoryEntry[], cfg?: ReasonixConfig): string | null {
  // Sort by scope/name so the block is byte-identical regardless of entry source
  // order — the file backend's readdir order and SQLite's row order differ, and this
  // block is pinned into the immutable prefix (prefix-cache hash stability). Matches
  // the index/TOON blocks, which already sort the same way.
  const high = entries
    .filter((e) => effectivePriority(e, cfg) === "high")
    .sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`));
  if (high.length === 0) return null;
  const lines: string[] = [
    "# HIGH PRIORITY constraints (must observe)",
    "",
    "These memories were declared `priority: high` (via config.memory.customTypes or the memory file itself). Treat them as hard rules — violations override any other guidance below.",
    "",
  ];
  for (const e of high) {
    const head = `!!! [${e.scope}/${e.type}/${e.name}] ${e.description || "(no description)"}`;
    lines.push(head);
    if (e.body) lines.push("", e.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Empty index → omit the whole block (otherwise we'd add bytes to the prefix hash for nothing). */
export function applyUserMemory(
  basePrompt: string,
  opts: {
    homeDir?: string;
    projectRoot?: string;
    cfg?: ReasonixConfig;
    toonMode?: ToonMode;
  } = {},
): string {
  if (!memoryEnabled()) return basePrompt;
  // SQLite-only: the prefix READ path and every WRITE site share one backend, so a
  // remembered fact is always reflected here (no file/SQLite split-brain). loadIndexContent
  // / listEntriesSync are synchronous and byte-identical to the old file rendering (SC-003).
  const store = new SqliteMemoryStore(getDb(), opts.projectRoot, opts.homeDir);
  const global = store.loadIndexContent("global");
  const project = store.hasProjectScope() ? store.loadIndexContent("project") : null;
  const entries = store.listEntriesSync();
  const high = highPriorityBlock(entries, opts.cfg);
  if (!global && !project && !high) return basePrompt;
  const parts: string[] = [basePrompt];
  if (high) parts.push("", high);
  if (toonPrefixEnabled(opts.toonMode)) {
    const summaries = entries
      .map((entry) => {
        const priority = effectivePriority(entry, opts.cfg);
        return {
          scope: entry.scope,
          type: entry.type,
          name: entry.name,
          description: entry.description,
          ...(priority ? { priority } : {}),
          ...(entry.expires ? { expires: entry.expires } : {}),
        };
      })
      .sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`));
    if (summaries.length > 0) {
      parts.push(
        "",
        "# User memory index",
        "",
        "Cross-project and project memory summaries. Treat as authoritative; call `recall_memory` when a summary is insufficient.",
        "",
        formatPromptPayloadBlock({ memories: summaries }, { mode: opts.toonMode }),
      );
      return parts.join("\n");
    }
  }
  if (global) {
    parts.push(
      "",
      "# User memory — global (~/.reasonix/memory/global/MEMORY.md)",
      "",
      "Cross-project facts and preferences the user has told you in prior sessions. TREAT AS AUTHORITATIVE — don't re-verify via filesystem or web. One-liners index detail files; call `recall_memory` for full bodies only when the one-liner isn't enough.",
      "",
      "```",
      global.content,
      "```",
    );
  }
  if (project) {
    parts.push(
      "",
      "# User memory — this project",
      "",
      "Per-project facts the user established in prior sessions (not committed to the repo). TREAT AS AUTHORITATIVE. Same recall pattern as global memory.",
      "",
      "```",
      project.content,
      "```",
    );
  }
  return parts.join("\n");
}

export function applyMemoryStack(
  basePrompt: string,
  rootDir: string,
  opts: { homeDir?: string; cfg?: ReasonixConfig; toonMode?: ToonMode } = {},
): string {
  const homeDir = opts.homeDir;
  const cfg = opts.cfg;
  const withProject = applyProjectMemory(basePrompt, rootDir);
  const withGlobal = applyGlobalReasonixMemory(
    withProject,
    homeDir ? join(homeDir, ".reasonix") : undefined,
  );
  const withMemory = applyUserMemory(withGlobal, {
    projectRoot: rootDir,
    homeDir,
    cfg,
    toonMode: opts.toonMode,
  });
  const customSkillPaths = cfg?.skills?.paths
    ? resolveSkillPaths(cfg.skills.paths, rootDir)
    : loadResolvedSkillPaths(rootDir);
  return applySkillsIndex(withMemory, {
    projectRoot: rootDir,
    homeDir,
    customSkillPaths,
    toonMode: opts.toonMode,
  });
}

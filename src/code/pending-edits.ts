/** Best-effort overwrite-on-write checkpoint; ephemeral sessions skip persistence. */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sanitizeName, sessionsDir } from "../memory/session.js";
import {
  legacyJsonPathFor,
  readStructuredFileSync,
  writeStructuredFileSync,
} from "../toon/persistence.js";
import type { EditBlock } from "./edit-blocks.js";

/** Absolute path for the checkpoint file that belongs to this session. */
export function pendingEditsPath(sessionName: string): string {
  return join(sessionsDir(), `${sanitizeName(sessionName)}.pending.toon`);
}

/** No-op for ephemeral sessions; empty `blocks` deletes the checkpoint file. */
export function savePendingEdits(sessionName: string | null, blocks: EditBlock[]): void {
  if (!sessionName) return;
  const path = pendingEditsPath(sessionName);
  try {
    if (blocks.length === 0) {
      clearPendingEdits(sessionName);
      return;
    }
    writeStructuredFileSync(path, blocks);
  } catch {
    /* best-effort — disk full / perms should not break the session */
  }
}

/** Malformed file → null — silent recovery beats failing to open the session. */
export function loadPendingEdits(sessionName: string | null): EditBlock[] | null {
  if (!sessionName) return null;
  const path = pendingEditsPath(sessionName);
  try {
    const parsed = readStructuredFileSync<unknown>(path);
    if (!Array.isArray(parsed)) return null;
    const out: EditBlock[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.path === "string" &&
        typeof item.search === "string" &&
        typeof item.replace === "string" &&
        typeof item.offset === "number"
      ) {
        out.push(item as EditBlock);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Delete the checkpoint file unconditionally — called by /apply and /discard. */
export function clearPendingEdits(sessionName: string | null): void {
  if (!sessionName) return;
  const path = pendingEditsPath(sessionName);
  try {
    if (existsSync(path)) unlinkSync(path);
    const legacy = legacyJsonPathFor(path);
    if (legacy !== path && existsSync(legacy)) unlinkSync(legacy);
  } catch {
    /* best-effort */
  }
}

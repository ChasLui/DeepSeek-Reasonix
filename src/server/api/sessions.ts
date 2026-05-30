import { deleteSession, listSessions, sanitizeName, sessionPath } from "../../memory/session.js";
import { getDb } from "../../storage/db.js";
import { loadSessionMessagesDb } from "../../storage/sessions-repo.js";
import type { ChatMessage } from "../../types.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface SessionMessage {
  role: string;
  content?: string;
  toolName?: string;
  /** Raw record. Kept for debug; SPA reads from `role`/`content` first. */
  raw?: unknown;
}

/** True when the session has a conversation-log row under SQLite. */
function sessionExists(name: string): boolean {
  return loadSessionMessagesDb(getDb(), sanitizeName(name)).length > 0;
}

/** Project the SQLite conversation-log into the SPA's flat message shape. */
function loadTranscript(name: string): SessionMessage[] {
  const rows = loadSessionMessagesDb(getDb(), sanitizeName(name)) as ChatMessage[];
  return rows.map((rec) => {
    const msg: SessionMessage = {
      role: typeof rec.role === "string" ? rec.role : "unknown",
    };
    if (typeof rec.content === "string") msg.content = rec.content;
    else if (rec.content != null) msg.content = JSON.stringify(rec.content);
    if (typeof rec.name === "string") msg.toolName = rec.name;
    return msg;
  });
}

export async function handleSessions(
  method: string,
  rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  // Listing.
  if (method === "GET" && rest.length === 0) {
    const sessions = listSessions();
    const currentName = ctx.getSessionName?.() ?? null;
    return {
      status: 200,
      body: {
        sessions: sessions.map((s) => ({
          name: s.name,
          path: s.path,
          size: s.size,
          messageCount: s.messageCount,
          mtime: s.mtime.getTime(),
        })),
        currentSession: currentName,
        canSwitch: Boolean(ctx.switchSession),
      },
    };
  }

  // New session — mints a fresh session by calling switchSession(undefined),
  // which routes through the same path the SessionPicker "new" branch takes.
  if (method === "POST" && rest.length === 1 && rest[0] === "new") {
    if (!ctx.switchSession) {
      return {
        status: 503,
        body: { error: "live session swap requires an attached CLI session." },
      };
    }
    const result = ctx.switchSession(undefined);
    if (!result.ok) return { status: 500, body: { error: result.reason } };
    return { status: 200, body: { ok: true } };
  }

  if (rest.length === 0) {
    return {
      status: 405,
      body: { error: `method ${method} not supported on /sessions` },
    };
  }

  // Single-session detail / switch / delete. URL-decode in case the name
  // had spaces / CJK (sanitizeName allows them).
  const name = decodeURIComponent(rest[0]!);
  const path = sessionPath(name);
  const currentName = ctx.getSessionName?.() ?? null;

  if (method === "POST" && rest[1] === "switch") {
    if (!ctx.switchSession) {
      return {
        status: 503,
        body: { error: "live session swap requires an attached CLI session." },
      };
    }
    if (!sessionExists(name)) return { status: 404, body: { error: `no such session: ${name}` } };
    const result = ctx.switchSession(name);
    if (!result.ok) return { status: 500, body: { error: result.reason } };
    return { status: 200, body: { ok: true } };
  }

  if (method === "DELETE") {
    if (rest.length !== 1) {
      return {
        status: 405,
        body: { error: `method ${method} not supported on this path` },
      };
    }
    // Refuse to delete the currently-attached session — the live process
    // still has the file open for append, and deleting it would resurrect
    // an empty file on the next message.
    if (currentName && name === currentName) {
      return {
        status: 409,
        body: {
          error: "cannot delete the currently-active session — switch away first.",
        },
      };
    }
    if (!sessionExists(name)) return { status: 404, body: { error: `no such session: ${name}` } };
    const removed = deleteSession(name);
    if (!removed) return { status: 500, body: { error: `failed to delete ${name}` } };
    ctx.audit?.({
      ts: Date.now(),
      action: "delete-session",
      payload: { name },
    });
    return { status: 200, body: { ok: true, deleted: name } };
  }

  if (method === "GET") {
    if (rest.length !== 1) {
      return {
        status: 405,
        body: { error: `method ${method} not supported on this path` },
      };
    }
    if (!sessionExists(name)) return { status: 404, body: { error: `no such session: ${name}` } };
    const messages = loadTranscript(name);
    return {
      status: 200,
      body: { name, path, messages, messageCount: messages.length },
    };
  }

  return {
    status: 405,
    body: { error: `method ${method} not supported on this path` },
  };
}

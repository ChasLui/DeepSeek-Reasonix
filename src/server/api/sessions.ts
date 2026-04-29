import { existsSync, readFileSync } from "node:fs";
import { listSessions, sessionPath } from "../../memory/session.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface SessionMessage {
  role: string;
  content?: string;
  toolName?: string;
  /** Raw record. Kept for debug; SPA reads from `role`/`content` first. */
  raw?: unknown;
}

function parseTranscript(path: string, maxBytes = 4 * 1024 * 1024): SessionMessage[] {
  // Cap reads at 4 MB so a runaway session file (rare but possible)
  // doesn't tie up the server. The `head` of a long session is the
  // useful part; we surface a `truncated` flag in the response.
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (raw.length > maxBytes) raw = raw.slice(0, maxBytes);
  const out: SessionMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      const role = typeof rec.role === "string" ? rec.role : "unknown";
      const msg: SessionMessage = { role };
      if (typeof rec.content === "string") msg.content = rec.content;
      else if (rec.content !== undefined) msg.content = JSON.stringify(rec.content);
      if (typeof rec.tool_name === "string") msg.toolName = rec.tool_name;
      if (typeof rec.toolName === "string") msg.toolName = rec.toolName;
      out.push(msg);
    } catch {
      /* skip malformed line — same rule as the rest of Reasonix's JSONL readers */
    }
  }
  return out;
}

export async function handleSessions(
  method: string,
  rest: string[],
  _body: string,
  _ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }

  // Listing.
  if (rest.length === 0) {
    const sessions = listSessions();
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
      },
    };
  }

  // Single-session detail. URL-decode in case the name had spaces / CJK
  // (sanitizeName allows them).
  const name = decodeURIComponent(rest[0]!);
  const path = sessionPath(name);
  if (!existsSync(path)) {
    return { status: 404, body: { error: `no such session: ${name}` } };
  }
  const messages = parseTranscript(path);
  return {
    status: 200,
    body: {
      name,
      path,
      messages,
      messageCount: messages.length,
    },
  };
}

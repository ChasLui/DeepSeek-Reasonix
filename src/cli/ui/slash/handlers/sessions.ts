import {
  deleteSession,
  listSessions,
  pruneStaleSessions,
  renameSession,
} from "../../../../memory/session.js";
import type { SlashHandler } from "../dispatch.js";

const STALE_THRESHOLD_DAYS = 90;

const sessions: SlashHandler = () => ({ openSessionsPicker: true });

const forget: SlashHandler = (_args, loop) => {
  if (!loop.sessionName) {
    return { info: "not in a session — nothing to forget" };
  }
  const name = loop.sessionName;
  const ok = deleteSession(name);
  return {
    info: ok
      ? `▸ deleted session "${name}" — current screen still shows the conversation, but next launch starts fresh`
      : `could not delete session "${name}" (already gone?)`,
  };
};

const pruneSessions: SlashHandler = (args) => {
  // Optional first arg: cutoff in days (default 90). Lets users
  // tighten the threshold for a one-off purge without editing code.
  const raw = args?.[0];
  const days = raw ? Number.parseInt(raw, 10) : STALE_THRESHOLD_DAYS;
  if (!Number.isFinite(days) || days < 1) {
    return {
      info: `▸ usage: /prune-sessions [days]   — defaults to ${STALE_THRESHOLD_DAYS}, must be ≥1`,
    };
  }
  const removed = pruneStaleSessions(days);
  if (removed.length === 0) {
    return { info: `▸ nothing to prune — no sessions idle ≥${days} days` };
  }
  return {
    info: `▸ pruned ${removed.length} session${removed.length === 1 ? "" : "s"} idle ≥${days} days: ${removed.join(", ")}`,
  };
};

const rename: SlashHandler = (args, loop) => {
  const newName = args?.[0]?.trim();
  if (!newName) return { info: "usage: /rename <new-name>" };
  if (!loop.sessionName) return { info: "not in a session — nothing to rename" };
  const ok = renameSession(loop.sessionName, newName);
  if (!ok) {
    return {
      info: `could not rename — "${newName}" already exists or sanitises to the same id as the current session`,
    };
  }
  return {
    info: `▸ renamed session → "${newName}". Restart the TUI to pick it up under its new name.`,
  };
};

const resume: SlashHandler = (args) => {
  const name = args?.[0]?.trim();
  if (!name) return { info: "usage: /resume <session-name>  — list with /sessions" };
  const exists = listSessions().some((s) => s.name === name);
  if (!exists) return { info: `no session named "${name}" — list with /sessions` };
  return {
    info: `▸ to resume "${name}", quit and run: reasonix chat --session ${name}\n  (mid-session swap requires a restart so the message log can rewind cleanly)`,
  };
};

export const handlers: Record<string, SlashHandler> = {
  sessions,
  forget,
  rename,
  resume,
  "prune-sessions": pruneSessions,
};

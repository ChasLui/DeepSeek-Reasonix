import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../i18n/index.js";
import type { ChatMessage, SessionInfo } from "../../index.js";
import {
  importClaudeCodeSession,
  listSessions,
  loadSessionMessages,
  sessionPath,
} from "../../memory/session.js";
import { indexImportedClaudeSessions } from "./memory.js";

export interface SessionsOptions {
  /** When present, inspect that session instead of listing. */
  name?: string;
  target?: string;
  /** Include assistant tool-call metadata in the inspect output. */
  verbose?: boolean;
  source?: string;
  index?: boolean;
}

export async function sessionsCommand(opts: SessionsOptions): Promise<void> {
  if (opts.name === "import-jsonl") {
    await importJsonl(opts.target, !!opts.index);
  } else if (opts.name && opts.name !== "list") {
    inspectSession(opts.name, !!opts.verbose);
  } else {
    listAll(opts.source);
  }
}

function listAll(source?: string): void {
  const items = listSessions(source ? { sourceFilter: source } : undefined);
  if (items.length === 0) {
    console.log(t("sessions.emptyHint"));
    return;
  }
  console.log("Saved sessions (~/.reasonix/sessions/):");
  console.log("");
  console.log(`  ${"name".padEnd(22)} ${"msgs".padStart(6)}  ${"size".padStart(8)}  modified`);
  console.log(`  ${"─".repeat(60)}`);
  for (const s of items) {
    const sizeKb = `${(s.size / 1024).toFixed(1)} KB`;
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    console.log(
      `  ${s.name.padEnd(22)} ${String(s.messageCount).padStart(6)}  ${sizeKb.padStart(8)}  ${when}`,
    );
    const details = sessionDetails(s);
    if (details.length > 0) console.log(`      ${details.join(" · ")}`);
  }
  console.log("");
  console.log("Inspect:  reasonix sessions <name>");
  console.log("Resume:   reasonix chat --session <name>");
}

async function importJsonl(target: string | undefined, index: boolean): Promise<void> {
  if (!target) {
    console.error("usage: reasonix sessions import-jsonl <path|dir> [--index]");
    process.exit(1);
  }
  const files = collectJsonlFiles(target);
  let added = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const file of files) {
    const result = importClaudeCodeSession(file);
    added += result.added > 0 ? 1 : 0;
    skipped += result.skipped;
    if (result.duplicate) duplicates += 1;
  }
  let indexNote = "";
  if (index) {
    const indexed = await indexImportedClaudeSessions();
    indexNote = `; indexed ${indexed.indexed} imported sessions into memory search`;
    if (indexed.semanticError) indexNote += ` (semantic skipped: ${indexed.semanticError})`;
  }
  console.log(
    `${added} added, ${duplicates} skipped (sessionId duplicate), ${skipped} skipped lines${indexNote}`,
  );
}

function collectJsonlFiles(target: string): string[] {
  if (!existsSync(target)) throw new Error(`path does not exist: ${target}`);
  const stat = statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) throw new Error(`not a file or directory: ${target}`);
  const files: string[] = [];
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      if (files.length > 1000) throw new Error("refusing to import more than 1000 jsonl files");
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function inspectSession(name: string, verbose: boolean): void {
  const path = sessionPath(name);
  const messages = loadSessionMessages(name);
  if (messages.length === 0) {
    console.error(`no session named "${name}" (or it's empty).`);
    console.error(`looked at: ${path}`);
    process.exit(1);
  }

  console.log(`[session] ${name}   ${messages.length} messages   ${path}`);
  console.log("");

  let turnIndex = 0;
  for (const msg of messages) {
    renderMessage(msg, turnIndex, verbose);
    // Roughly bump "turn" after each user message so the reader can follow
    // the conversation shape without the transcript's richer turn numbering.
    if (msg.role === "user") turnIndex++;
  }
}

function renderMessage(msg: ChatMessage, turnIdx: number, verbose: boolean): void {
  const turn = turnIdx > 0 ? `[t${turnIdx}]` : "[start]";
  const content = typeof msg.content === "string" ? msg.content : "";
  const flat = oneLine(content);

  if (msg.role === "user") {
    console.log(`${turn} USER: ${flat}`);
  } else if (msg.role === "assistant") {
    console.log(`${turn} AGENT: ${flat || "(tool call only)"}`);
    if (verbose && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        console.log(
          `         → call ${tc.function?.name} ${truncate(tc.function?.arguments ?? "", 80)}`,
        );
      }
    }
  } else if (msg.role === "tool") {
    console.log(`${turn} TOOL ${msg.name ?? "?"}: ${truncate(flat, 160)}`);
  } else if (msg.role === "system") {
    if (verbose) console.log(`${turn} SYSTEM: ${truncate(flat, 160)}`);
    // otherwise suppress — session's system prompt is usually session-wide
    // boilerplate.
  }
}

function oneLine(s: string, max = 200): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function sessionDetails(s: SessionInfo): string[] {
  const details: string[] = [];
  if (s.meta.summary) details.push(`summary: ${oneLine(s.meta.summary, 88)}`);
  if (s.meta.workspace) details.push(`workspace: ${workspaceLabel(s.meta.workspace)}`);
  if (s.meta.branch) details.push(`branch: ${truncate(s.meta.branch, 40)}`);
  return details;
}

function workspaceLabel(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, "");
  const label = trimmed.split(/[\\/]+/).at(-1) ?? trimmed;
  return truncate(label || workspace, 40);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

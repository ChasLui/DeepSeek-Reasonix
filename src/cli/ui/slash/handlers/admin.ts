import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import {
  HOOK_EVENTS,
  type HookEvent,
  type ResolvedHook,
  globalSettingsPath,
  projectSettingsPath,
} from "../../../../hooks.js";
import { aggregateUsage, defaultUsageLogPath, readUsageLog } from "../../../../telemetry/usage.js";
import { VERSION, compareVersions, isNpxInstall } from "../../../../version.js";
import { renderDashboard } from "../../../commands/stats.js";
import type { SlashHandler } from "../dispatch.js";

const hooks: SlashHandler = (args, loop, ctx) => {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    if (!ctx.reloadHooks) {
      return {
        info: "/hooks reload is not available in this context (no reload callback wired).",
      };
    }
    const count = ctx.reloadHooks();
    return { info: `▸ reloaded hooks · ${count} active` };
  }

  if (sub !== "" && sub !== "list" && sub !== "ls") {
    return {
      info: "usage: /hooks            list active hooks\n       /hooks reload     re-read settings.json files",
    };
  }

  const all = loop.hooks;
  const projPath = ctx.codeRoot ? projectSettingsPath(ctx.codeRoot) : undefined;
  const globPath = globalSettingsPath();
  if (all.length === 0) {
    const lines = [
      "no hooks configured.",
      "",
      "drop a settings.json with a `hooks` key into either of:",
      ctx.codeRoot
        ? `  · ${projPath} (project)`
        : "  · <project>/.reasonix/settings.json (project)",
      `  · ${globPath} (global)`,
      "",
      "events: PreToolUse, PostToolUse, UserPromptSubmit, Stop",
      "exit 0 = pass · exit 2 = block (Pre*) · other = warn",
    ];
    return { info: lines.join("\n") };
  }

  const grouped = new Map<HookEvent, ResolvedHook[]>();
  for (const event of HOOK_EVENTS) grouped.set(event, []);
  for (const h of all) grouped.get(h.event)?.push(h);

  const lines: string[] = [`▸ ${all.length} hook(s) loaded`];
  for (const event of HOOK_EVENTS) {
    const list = grouped.get(event) ?? [];
    if (list.length === 0) continue;
    lines.push("", `${event}:`);
    for (const h of list) {
      const match = h.match && h.match !== "*" ? ` match=${h.match}` : "";
      const desc = h.description ? `  — ${h.description}` : "";
      lines.push(`  [${h.scope}]${match} ${h.command}${desc}`);
    }
  }
  lines.push("", `sources: project=${projPath ?? "(none — chat mode)"} · global=${globPath}`);
  return { info: lines.join("\n") };
};

/** No in-TUI npm spawn — stdio:inherit corrupts Ink and Windows locks the running binary. */
const update: SlashHandler = (_args, _loop, ctx) => {
  const latest = ctx.latestVersion ?? null;
  const lines: string[] = [`current: reasonix ${VERSION}`];
  if (latest === null) {
    // Kick off a fresh fetch so a follow-up /update a few seconds
    // later has a real answer instead of the same pending message.
    ctx.refreshLatestVersion?.();
    lines.push(
      "latest:  (not yet resolved — background check in flight or offline)",
      "",
      "triggered a fresh registry fetch — retry `/update` in a few seconds,",
      "or run `reasonix update` in another terminal to force it synchronously.",
    );
    return { info: lines.join("\n") };
  }
  lines.push(`latest:  reasonix ${latest}`);
  const diff = compareVersions(VERSION, latest);
  if (diff >= 0) {
    lines.push("", "you're on the latest. nothing to do.");
    return { info: lines.join("\n") };
  }
  if (isNpxInstall()) {
    lines.push(
      "",
      "you're running via npx — the next `npx reasonix ...` launch will auto-fetch.",
      "to force a refresh sooner: `npm cache clean --force`.",
    );
  } else {
    lines.push(
      "",
      "to upgrade, exit this session and run:",
      "  reasonix update           (interactive, dry-run supported via --dry-run)",
      "  npm install -g reasonix@latest   (direct)",
      "",
      "in-session install is deliberately disabled — the npm spawn would",
      "corrupt this TUI's rendering and Windows can lock the running binary.",
    );
  }
  return { info: lines.join("\n") };
};

const stats: SlashHandler = () => {
  const path = defaultUsageLogPath();
  const records = readUsageLog(path);
  if (records.length === 0) {
    return {
      info: [
        "no usage data yet.",
        "",
        `  ${path}`,
        "",
        "every turn you run here appends one record — this session's turns",
        "will show up in the dashboard once you send a message.",
      ].join("\n"),
    };
  }
  const agg = aggregateUsage(records);
  return { info: renderDashboard(agg, path) };
};

/** MCP servers don't follow the switch — their stdio child anchored to original cwd at spawn. */
const cwd: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.setCwd) {
    return {
      info: "/cwd is not available in this context (no setCwd callback wired).",
    };
  }
  const raw = (args[0] ?? "").trim();
  if (!raw) {
    return {
      info: "usage: /cwd <path>   (absolute or relative, ~ expands to home)",
    };
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const expanded = raw.startsWith("~") && home ? pathMod.join(home, raw.slice(1)) : raw;
  const abs = pathMod.resolve(expanded);
  if (!existsSync(abs)) {
    return { info: `▸ /cwd: path does not exist — ${abs}` };
  }
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    // Permission denied or transient FS error — treat as not-a-dir
    // and let the user see the exact path so they can investigate.
  }
  if (!isDir) {
    return { info: `▸ /cwd: not a directory — ${abs}` };
  }
  let info: string;
  try {
    info = ctx.setCwd(abs);
  } catch (err) {
    return { info: `▸ /cwd failed: ${(err as Error).message}` };
  }
  const lines = [info];
  if (ctx.mcpServers && ctx.mcpServers.length > 0) {
    lines.push(
      `  note: ${ctx.mcpServers.length} MCP server(s) still anchored to the original cwd —`,
      "        their tools won't follow this switch. Restart the session for full reset.",
    );
  }
  return { info: lines.join("\n") };
};

const copy: SlashHandler = (_args, _loop, ctx) => {
  if (!ctx.enterCopyMode) {
    return { info: "/copy is not available in this context (TUI-internal)." };
  }
  ctx.enterCopyMode();
  return {};
};

export const handlers: Record<string, SlashHandler> = {
  hook: hooks,
  hooks,
  cwd,
  update,
  stats,
  copy,
};

import { basename } from "node:path";
import { listPlanArchives, loadPlanState, relativeTime } from "../../../../code/plan-store.js";
import type { SlashHandler } from "../dispatch.js";

const plans: SlashHandler = (_args, loop) => {
  const sessionName = loop.sessionName;
  if (!sessionName) {
    return {
      info: "no session attached — `/plans` is per-session. Run `reasonix code` in a project to get a session.",
    };
  }
  const lines: string[] = [];
  // Active (in-flight) plan summary first — it's the one the user is
  // most likely asking about.
  const active = loadPlanState(sessionName);
  if (active && active.steps.length > 0) {
    const total = active.steps.length;
    const done = active.completedStepIds.length;
    const when = relativeTime(active.updatedAt);
    const label = active.summary ? `: ${active.summary}` : "";
    lines.push(
      `▸ active plan${label} — ${done}/${total} step${total === 1 ? "" : "s"} done · last touched ${when}`,
    );
  } else {
    lines.push("▸ active plan: (none)");
  }

  // Archives (completed plans) — newest first.
  const archives = listPlanArchives(sessionName);
  if (archives.length === 0) {
    lines.push("");
    lines.push(
      "no archived plans yet for this session — they auto-archive when every step is done",
    );
    return { info: lines.join("\n") };
  }
  lines.push("");
  lines.push(`Archived (${archives.length}):`);
  for (const a of archives) {
    const when = relativeTime(a.completedAt);
    const total = a.steps.length;
    const done = a.completedStepIds.length;
    const completion = done >= total ? "complete" : `${done}/${total}`;
    // Prefer the model-supplied summary as the label; fall back to
    // the bare filename so legacy archives without a summary still
    // show something identifying.
    const label = a.summary ?? a.path.split(/[\\/]/).pop() ?? a.path;
    lines.push(
      `  ✓ ${when.padEnd(10)}  ${total} step${total === 1 ? "" : "s"} · ${completion}  ${label}`,
    );
  }
  return { info: lines.join("\n") };
};

const replay: SlashHandler = (args, loop) => {
  const sessionName = loop.sessionName;
  if (!sessionName) {
    return {
      info: "no session attached — `/replay` is per-session. Run `reasonix code` in a project to get a session.",
    };
  }
  const archives = listPlanArchives(sessionName);
  if (archives.length === 0) {
    return {
      info: "no archived plans yet for this session — `/replay` lights up once a plan completes (auto-archives when every step is done).",
    };
  }
  const arg = args[0]?.trim() ?? "";
  const index = arg ? Number.parseInt(arg, 10) : 1;
  if (!Number.isFinite(index) || index < 1 || index > archives.length) {
    return {
      info: `invalid index — \`/replay\` takes 1..${archives.length} (newest = 1). Use \`/plans\` to see the list.`,
    };
  }
  const a = archives[index - 1]!;
  return {
    replayPlan: {
      summary: a.summary,
      body: a.body,
      steps: a.steps,
      completedStepIds: a.completedStepIds,
      completedAt: a.completedAt,
      relativeTime: relativeTime(a.completedAt),
      archiveBasename: basename(a.path),
      index,
      total: archives.length,
    },
  };
};

export const handlers: Record<string, SlashHandler> = {
  plans,
  replay,
};

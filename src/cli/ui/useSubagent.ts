import { useEffect, useRef, useState } from "react";
import { appendUsage } from "../../telemetry/usage.js";
import type { SubagentEvent, SubagentSink } from "../../tools/subagent.js";
import type { Scrollback } from "./hooks/useScrollback.js";

export interface SubagentActivity {
  task: string;
  iter: number;
  elapsedMs: number;
}

export interface UseSubagentParams {
  session: string | undefined;
  log: Scrollback;
}

export interface UseSubagentResult {
  /** Live state for an in-flight subagent, null when none is running. */
  activity: SubagentActivity | null;
  sinkRef: React.MutableRefObject<SubagentSink>;
}

export function useSubagent({ session, log }: UseSubagentParams): UseSubagentResult {
  const [activity, setActivity] = useState<SubagentActivity | null>(null);
  const sinkRef = useRef<SubagentSink>({ current: null });

  useEffect(() => {
    sinkRef.current.current = (ev: SubagentEvent) => {
      if (ev.kind === "start") {
        setActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      if (ev.kind === "progress") {
        setActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      // end
      setActivity(null);
      const seconds = ((ev.elapsedMs ?? 0) / 1000).toFixed(1);
      // Inline cost: the one number most users look at. Saves a /stats round-trip.
      const costTail =
        ev.costUsd !== undefined && ev.costUsd > 0 ? ` · $${ev.costUsd.toFixed(4)}` : "";
      const summary = ev.error
        ? `⌬ subagent "${ev.task}" failed after ${seconds}s · ${ev.iter ?? 0} tool call(s) — ${ev.error}`
        : `⌬ subagent "${ev.task}" done in ${seconds}s · ${ev.iter ?? 0} tool call(s) · ${ev.turns ?? 0} turn(s)${costTail}`;
      log.pushInfo(summary);
      // Persist a subagent summary row to ~/.reasonix/usage.jsonl so
      // `/stats` and `reasonix stats` surface it. Skipped on error —
      // we only record what actually cost money and did work.
      if (!ev.error && ev.usage && ev.model) {
        appendUsage({
          session: session ?? null,
          model: ev.model,
          usage: ev.usage,
          kind: "subagent",
          subagent: {
            skillName: ev.skillName,
            taskPreview: ev.task.slice(0, 60),
            toolIters: ev.iter ?? 0,
            durationMs: ev.elapsedMs ?? 0,
          },
        });
      }
    };
    return () => {
      sinkRef.current.current = null;
    };
  }, [session, log]);

  return { activity, sinkRef };
}

/** Translate a daemon-forwarded ACP permission request into a local PauseGate ask + map the verdict back, so a rich client (desktop) reuses its existing confirm UI for daemon-hosted sessions. Inverse of acp/gates.ts. */

import type { PermissionRequestParams, PermissionRequestResult } from "../acp/protocol.js";
import type { PauseAskOpts } from "../core/pause-gate.js";

type PauseKind = PauseAskOpts["kind"];

/** Infer the original PauseGate kind + payload from the ACP request (option set + tool kind). */
export function acpPermissionToPauseAsk(params: PermissionRequestParams): PauseAskOpts {
  const optionIds = new Set(params.options.map((o) => o.optionId));
  const payload = (params.toolCall.rawInput ?? {}) as never;
  let kind: PauseKind;
  if (optionIds.has("refine")) kind = "plan_proposed";
  else if (optionIds.has("revise") || optionIds.has("stop")) kind = "plan_checkpoint";
  else if (optionIds.has("accept")) kind = "plan_revision";
  else if (optionIds.has("allow_always")) {
    kind = params.toolCall.kind === "execute" ? "run_command" : "path_access";
  } else kind = "choice";
  return { kind, payload } as PauseAskOpts;
}

/** Map the local PauseGate verdict back to an ACP outcome, aligned with acp/gates.ts verdictFor. */
export function pauseVerdictToAcp(kind: PauseKind, verdict: unknown): PermissionRequestResult {
  const v = verdict as { type?: string; optionId?: string };
  const selected = (optionId: string): PermissionRequestResult => ({
    outcome: { outcome: "selected", optionId },
  });
  const cancelled: PermissionRequestResult = {
    outcome: { outcome: "cancelled" },
  };
  switch (kind) {
    case "run_command":
    case "run_background":
    case "path_access":
      if (v.type === "always_allow") return selected("allow_always");
      if (v.type === "run_once") return selected("allow_once");
      return cancelled; // deny
    case "plan_proposed":
      if (v.type === "approve") return selected("allow_once");
      if (v.type === "refine") return selected("refine");
      return cancelled;
    case "plan_checkpoint":
      if (v.type === "continue") return selected("allow_once");
      if (v.type === "revise") return selected("revise");
      return cancelled; // stop
    case "plan_revision":
      if (v.type === "accepted") return selected("accept");
      if (v.type === "rejected") return selected("reject");
      return cancelled;
    case "choice":
      if (v.type === "pick" && v.optionId) return selected(v.optionId);
      return cancelled;
    default:
      return cancelled;
  }
}

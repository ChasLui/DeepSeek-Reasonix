/** confirm-bridge — daemon ACP permission ↔ local PauseGate (so the desktop reuses its confirm UI). */

import { describe, expect, it } from "vitest";
import type { PermissionRequestParams } from "../src/acp/protocol.js";
import { acpPermissionToPauseAsk, pauseVerdictToAcp } from "../src/daemon/confirm-bridge.js";

function params(
  kind: "execute" | "edit" | "other",
  optionIds: string[],
  rawInput: unknown,
): PermissionRequestParams {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t", kind, rawInput },
    options: optionIds.map((optionId) => ({
      optionId,
      name: optionId,
      kind: optionId === "reject" ? "reject_once" : "allow_once",
    })),
  };
}

describe("acpPermissionToPauseAsk", () => {
  it("infers run_command from execute + allow_always", () => {
    const ask = acpPermissionToPauseAsk(
      params("execute", ["allow_once", "allow_always", "reject"], {
        command: "ls",
      }),
    );
    expect(ask.kind).toBe("run_command");
    expect(ask.payload).toEqual({ command: "ls" });
  });

  it("infers path_access for a non-execute tool with allow_always", () => {
    expect(
      acpPermissionToPauseAsk(params("edit", ["allow_once", "allow_always", "reject"], {})).kind,
    ).toBe("path_access");
  });

  it("infers plan kinds + choice from the option set", () => {
    expect(
      acpPermissionToPauseAsk(params("other", ["allow_once", "refine", "cancel"], {})).kind,
    ).toBe("plan_proposed");
    expect(
      acpPermissionToPauseAsk(params("other", ["allow_once", "revise", "stop"], {})).kind,
    ).toBe("plan_checkpoint");
    expect(acpPermissionToPauseAsk(params("other", ["accept", "reject"], {})).kind).toBe(
      "plan_revision",
    );
    expect(acpPermissionToPauseAsk(params("other", ["opt-a", "opt-b", "cancel"], {})).kind).toBe(
      "choice",
    );
  });
});

describe("pauseVerdictToAcp", () => {
  it("maps shell verdicts to option ids / cancelled", () => {
    expect(pauseVerdictToAcp("run_command", { type: "run_once" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(pauseVerdictToAcp("run_command", { type: "always_allow" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
    expect(pauseVerdictToAcp("run_command", { type: "deny" })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("maps plan + choice verdicts", () => {
    expect(pauseVerdictToAcp("plan_proposed", { type: "refine" })).toEqual({
      outcome: { outcome: "selected", optionId: "refine" },
    });
    expect(pauseVerdictToAcp("plan_revision", { type: "accepted" })).toEqual({
      outcome: { outcome: "selected", optionId: "accept" },
    });
    expect(pauseVerdictToAcp("choice", { type: "pick", optionId: "x" })).toEqual({
      outcome: { outcome: "selected", optionId: "x" },
    });
    expect(pauseVerdictToAcp("choice", { type: "cancel" })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

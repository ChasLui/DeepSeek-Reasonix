/** Interactive permission resolver — maps a terminal choice to an ACP outcome, fail-closed on bad input. */

import { describe, expect, it } from "vitest";
import type { PermissionRequestParams } from "../src/acp/protocol.js";
import {
  type PermissionPromptIo,
  formatPermissionPrompt,
  resolvePermissionInteractively,
} from "../src/daemon/permission-prompt.js";

function params(): PermissionRequestParams {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "t",
      title: "Run command — ls",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls" },
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
}

function fakeIo(answer: string): PermissionPromptIo {
  return { write: () => undefined, ask: async () => answer };
}

describe("resolvePermissionInteractively", () => {
  it("selects the option chosen by number", async () => {
    expect(await resolvePermissionInteractively(params(), fakeIo("1"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(await resolvePermissionInteractively(params(), fakeIo("2"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
  });

  it("out-of-range input fails closed to the reject option", async () => {
    expect(await resolvePermissionInteractively(params(), fakeIo("9"))).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("empty input fails closed to the reject option", async () => {
    expect(await resolvePermissionInteractively(params(), fakeIo("   "))).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("cancels when input is invalid and no reject option is offered", async () => {
    const p = params();
    p.options = [{ optionId: "a", name: "A", kind: "allow_once" }];
    expect(await resolvePermissionInteractively(p, fakeIo("x"))).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("renders the title and numbered options", () => {
    const text = formatPermissionPrompt(params());
    expect(text).toContain("Run command — ls");
    expect(text).toContain("1) Allow once");
    expect(text).toContain("3) Reject");
  });
});

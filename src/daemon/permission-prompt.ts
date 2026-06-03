/** Render a daemon-forwarded session/request_permission as a terminal prompt and map the user's pick back to an ACP outcome. */

import type { PermissionRequestParams, PermissionRequestResult } from "../acp/protocol.js";

export interface PermissionPromptIo {
  write: (text: string) => void;
  /** Read one line — the user's choice. */
  ask: (query: string) => Promise<string>;
}

export function formatPermissionPrompt(params: PermissionRequestParams): string {
  const title = params.toolCall.title ?? "Confirm action";
  const lines = [`\n⚠ ${title}`];
  params.options.forEach((o, i) => lines.push(`  ${i + 1}) ${o.name}`));
  return lines.join("\n");
}

/** Resolve interactively. Out-of-range / empty input fails closed: a reject option if the request offers one, else cancelled. */
export async function resolvePermissionInteractively(
  params: PermissionRequestParams,
  io: PermissionPromptIo,
): Promise<PermissionRequestResult> {
  io.write(`${formatPermissionPrompt(params)}\n`);
  const answer = (await io.ask(`Choose 1-${params.options.length} (default: reject): `)).trim();
  const idx = Number.parseInt(answer, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= params.options.length) {
    const opt = params.options[idx - 1];
    if (opt) return { outcome: { outcome: "selected", optionId: opt.optionId } };
  }
  const reject = params.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
  return { outcome: { outcome: "cancelled" } };
}

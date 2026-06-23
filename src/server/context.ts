/** Callbacks (not refs) so endpoints read live loop state per request, not a frozen closure. */

import type { McpServerSummary } from "../cli/ui/slash/types.js";
import type { EditMode } from "../config.js";
import type { CacheFirstLoop } from "../loop.js";
import type { ToolRegistry } from "../tools.js";
import type { JobRegistry } from "../tools/jobs.js";

export interface DashboardContext {
  /** Caller resolves via `defaultConfigPath()`; module deliberately avoids `homedir()` so tests can redirect. */
  configPath: string;
  /** Override the sessions dir (events.jsonl readers); production reads `~/.reasonix/sessions`. */
  sessionsDir?: string | undefined;
  mode: "standalone" | "attached";

  loop?: CacheFirstLoop | undefined;
  tools?: ToolRegistry | undefined;
  getMcpServers?: (() => McpServerSummary[] | undefined) | undefined;
  /** Per-spec bridge failures — drives the "未桥接" reason shown in the dashboard. */
  getMcpFailures?: () => Array<{
    spec: string;
    name: string;
    reason: string;
    at: number;
  }>;
  jobs?: JobRegistry | undefined;

  /** Current code-mode root, if any. Drives the project-scoped allowlist. */
  getCurrentCwd?: (() => string | undefined) | undefined;
  /** Current edit gate. */
  getEditMode?: (() => EditMode | undefined) | undefined;
  /** Plan-mode toggle state. */
  getPlanMode?: (() => boolean | undefined) | undefined;
  /** Current pending-edit-block count. */
  getPendingEditCount?: (() => number | undefined) | undefined;
  /** Latest published version (background-fetched by App). Null = pending/offline. */
  getLatestVersion?: (() => string | null | undefined) | undefined;
  getSessionName?: (() => string | null | undefined) | undefined;

  setEditMode?: ((mode: EditMode) => EditMode | undefined) | undefined;
  setPlanMode?: ((on: boolean) => void) | undefined;
  /** Flips live loop model + escalation; persisted config alone wouldn't affect the running session. */
  applyPresetLive?: ((name: string) => void) | undefined;
  /** Side-channel to live loop — settings POST persists, this flips the running session. */
  applyEffortLive?: ((effort: "high" | "max") => void) | undefined;
  /** Same model swap path /model <id> takes — live + persisted. */
  applyModelLive?: ((model: string) => void) | undefined;
  /** Cached model catalog. Null = in flight / failed; `[]` = API answered empty. */
  getModels?: (() => string[] | null | undefined) | undefined;
  /** One-shot v4-pro arming for the next turn. `armed=false` cancels a pending arm. */
  setProNextLive?: ((armed: boolean) => void) | undefined;
  /** Session USD cap; null disables. Re-arms the 80% warning latch. */
  setBudgetUsdLive?: ((usd: number | null) => void) | undefined;
  /** Auto-resubmit timer status — same shape `useLoopMode` exposes to slash handlers. */
  getLoopRunStatus?: () => {
    prompt: string;
    intervalMs: number;
    iter: number;
    nextFireMs: number;
  } | null;
  /** Start the auto-resubmit timer. Same path the `/loop` slash takes. */
  startAutoLoop?: ((intervalMs: number, prompt: string) => void) | undefined;
  /** Clear the auto-resubmit timer. */
  stopAutoLoop?: (() => void) | undefined;
  /** Endpoints don't write the audit log themselves so tests can swap the implementation. */
  audit?: ((entry: AuditEntry) => void) | undefined;

  getMessages?: (() => DashboardMessage[] | undefined) | undefined;
  /** Events are JSON-serializable subsets — raw `LoopEvent` carries React-only state. */
  subscribeEvents?: ((handler: (event: DashboardEvent) => void) => () => void) | undefined;
  /** Routes through the TUI's `handleSubmit` so slashes, `!cmd`, `@path`, plan-mode gating all match. */
  submitPrompt?: ((text: string) => SubmitResult | undefined) | undefined;
  abortTurn?: (() => void) | undefined;
  isBusy?: (() => boolean | undefined) | undefined;
  getStats?: (() => DashboardStats | null | undefined) | undefined;

  /** Snapshot of any modal currently up (for SSE clients that connect mid-modal). */
  getActiveModal?: (() => ActiveModal | null | undefined) | undefined;
  resolveShellConfirm?: ((choice: "run_once" | "always_allow" | "deny") => void) | undefined;
  resolveChoiceConfirm?: ((choice: ChoiceResolution) => void) | undefined;
  resolvePlanConfirm?:
    | ((choice: "approve" | "refine" | "cancel", text?: string) => void)
    | undefined;
  resolveEditReview?:
    | ((choice: "apply" | "reject" | "apply-rest-of-turn" | "flip-to-auto") => void)
    | undefined;
  resolveCheckpointConfirm?:
    | ((choice: "continue" | "revise" | "stop", text?: string) => void)
    | undefined;
  resolveReviseConfirm?: ((choice: "accept" | "reject") => void) | undefined;
  /** Active picker (sessions / checkpoints / mcp marketplace / …) resolves into the live TUI component via a runtime ref. */
  resolvePicker?: ((resolution: PickerResolution) => void) | undefined;
  /** Active read-only viewer (replay-plan / …) — only `close` is meaningful since the viewer carries no selection state. */
  resolveViewer?: (resolution: { action: "close" }) => void;

  reloadHooks?: (() => number | undefined) | undefined;
  reloadMcp?: (() => Promise<number> | undefined) | undefined;
  /** Live session swap — pass a name to switch into an existing session, or `undefined` to mint a fresh one. Available only in attached mode (an active CLI session to swap inside of). */
  switchSession?:
    | ((name: string | undefined) => { ok: true } | { ok: false; reason: string })
    | undefined;
  invokeMcpTool?:
    | ((serverLabel: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  /** Without this, registry has the tool but the prefix shown to the model stays stale until restart. */
  addToolToPrefix?: ((spec: import("../types.js").ToolSpec) => boolean | undefined) | undefined;
}

export type ChoiceResolution =
  | { kind: "pick"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "cancel" };

/** Web-driven action against the picker that's currently up. `refine` and `load-more` keep the picker open; everything else closes it. */
export type PickerResolution =
  | { action: "pick"; id: string }
  | { action: "delete"; id: string }
  | { action: "rename"; id: string; text: string }
  | { action: "new"; text?: string }
  | { action: "install"; id: string }
  | { action: "uninstall"; id: string }
  | { action: "load-more" }
  | { action: "refine"; query: string }
  | { action: "cancel" };

export type PickerAction = PickerResolution["action"];

export interface PickerItem {
  id: string;
  title: string;
  /** Secondary line — relative timestamp, branch, description. */
  subtitle?: string | undefined;
  /** Right-aligned tag — installed / active / source. */
  badge?: string | undefined;
  /** Trailing meta — file count, popularity, cost. */
  meta?: string | undefined;
}

export interface DashboardStats {
  /** Total turns this session. */
  turns: number;
  /** Cumulative session cost in USD. */
  totalCostUsd: number;
  /** Cost of the most recent turn. */
  lastTurnCostUsd: number;
  /** Input + output split — drives "in $X · out $Y" rendering. */
  totalInputCostUsd: number;
  totalOutputCostUsd: number;
  /** Cache hit ratio across the session, 0..1. */
  cacheHitRatio: number;
  /** Prompt tokens of the most recent turn — feeds the ctx gauge. */
  lastPromptTokens: number;
  /** Per-model context cap in tokens (1_000_000 for V4). */
  contextCapTokens: number;
  /** Null while background fetch pending OR on offline/auth failure — SPA renders first entry. */
  balance: Array<{
    currency: string;
    total_balance: string;
    granted_balance?: string | undefined;
    topped_up_balance?: string | undefined;
  }> | null;
}

/** Active modal snapshot — same shape as a `modal-*-up` SSE event payload. */
export type ActiveModal =
  | {
      kind: "shell";
      command: string;
      allowPrefix: string;
      shellKind: "run_command" | "run_background";
    }
  | {
      kind: "choice";
      question: string;
      options: Array<{ id: string; title: string; summary?: string | undefined }>;
      allowCustom: boolean;
    }
  | { kind: "plan"; body: string }
  | {
      kind: "edit-review";
      path: string;
      /** Both halves for side-by-side diff; `preview` kept for older flat-string clients. */
      search: string;
      replace: string;
      preview: string;
      total: number;
      remaining: number;
    }
  | {
      kind: "checkpoint";
      stepId: string;
      title?: string | undefined;
      completed: number;
      total: number;
    }
  | {
      kind: "revision";
      reason: string;
      remainingSteps: Array<{
        id: string;
        title: string;
        action: string;
        risk?: "low" | "med" | "high" | undefined;
      }>;
      summary?: string | undefined;
    }
  | {
      kind: "picker";
      /** Discriminator for the underlying picker (sessions / checkpoints / mcp-marketplace / …). Drives empty-state copy + icon on the SPA. */
      pickerKind: string;
      title: string;
      query?: string | undefined;
      items: PickerItem[];
      actions: PickerAction[];
      hasMore?: boolean | undefined;
      hint?: string | undefined;
    }
  | {
      kind: "viewer";
      /** Discriminator for the underlying viewer (replay-plan / …). */
      viewerKind: string;
      title: string;
      /** Markdown / plain text body. */
      body?: string | undefined;
      /** Structured plan steps when viewerKind === "replay-plan". */
      steps?: Array<{ id: string; title: string; status: "done" | "queued" }> | undefined;
      meta?: string | undefined;
    };

/** One row of the conversation as the SPA renders it. */
export interface DashboardMessage {
  id: string;
  role: "user" | "assistant" | "info" | "warning" | "tool";
  text: string;
  /** When `role === "tool"` — name of the tool that produced this result. */
  toolName?: string | undefined;
  /** Raw JSON args (role=tool) — lets SPA render tool-specific cards instead of a generic blob. */
  toolArgs?: string | undefined;
  /** Optional reasoning content for assistant messages (R1 / V4 thinking). */
  reasoning?: string | undefined;
}

export type DashboardEvent =
  | {
      kind: "assistant_delta";
      id: string;
      contentDelta?: string | undefined;
      reasoningDelta?: string | undefined;
    }
  | { kind: "assistant_final"; id: string; text: string; reasoning?: string | undefined }
  | { kind: "tool_start"; id: string; toolName: string; args?: string | undefined }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      content: string;
      args?: string | undefined;
    }
  | { kind: "warning"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "info"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "busy-change"; busy: boolean }
  | { kind: "status"; text: string }
  | { kind: "modal-up"; modal: ActiveModal }
  | { kind: "modal-down"; modalKind: ActiveModal["kind"] }
  | { kind: "ping" };

export interface SubmitResult {
  accepted: boolean;
  reason?: string | undefined;
}

/** Append-only — same rules as `usage.jsonl`, never rewritten. */
export interface AuditEntry {
  ts: number;
  /** `add-allowlist`, `remove-allowlist`, `set-edit-mode`, etc. */
  action: string;
  /** Free-form payload for the action. Keep PII out (no prompts). */
  payload?: Record<string, unknown> | undefined;
}

import type { EditMode } from "../../../config.js";
import type { McpServerSummary } from "../../../mcp/summary.js";
import type { JobRegistry } from "../../../tools/jobs.js";
import type { PlanStep } from "../../../tools/plan.js";

export type { McpServerSummary } from "../../../mcp/summary.js";

export interface SlashResult {
  /** Text to display back to the user as a system/info line. */
  info?: string | undefined;
  /** Open the SessionPicker modal mid-chat — used by `/sessions` slash. */
  openSessionsPicker?: boolean | undefined;
  /** Open the WorkspacePicker modal mid-chat — bare `/cwd` in code mode. */
  openWorkspacePicker?: boolean | undefined;
  /** Open the CheckpointPicker modal — bare `/restore` (no name argument). */
  openCheckpointPicker?: boolean | undefined;
  /** Open the ModelPicker modal — bare `/model` (no id) opens it. */
  openModelPicker?: boolean | undefined;
  /** Open the ThemePicker modal — bare `/theme` opens it. */
  openThemePicker?: boolean | undefined;
  /** Open the unified MCP hub — `/mcp` defaults to "live", `/mcp browse` to "marketplace". */
  openMcpHub?: { tab: "live" | "marketplace" };
  /** Open copy mode — yank chat text to clipboard via OSC 52. */
  openCopyMode?: boolean | undefined;
  /** Open the arg-completer picker for this command (e.g. `/language` → language picker). */
  openArgPickerFor?: string | undefined;
  /** Exit the app. */
  exit?: boolean | undefined;
  /** Clear the visible history. */
  clear?: boolean | undefined;
  /** Unknown command — display usage hint. */
  unknown?: boolean | undefined;
  /** `/retry` re-submit text — pushed back through the normal submit flow after log truncation. */
  resubmit?: string | undefined;
  /** Structured `/context` payload — `info` text can't carry per-segment color for the stacked bar. */
  ctxBreakdown?: {
    systemTokens: number;
    toolsTokens: number;
    logTokens: number;
    inputTokens: number;
    ctxMax: number;
    toolsCount: number;
    logMessages: number;
    topTools: Array<{ name: string; tokens: number; turn: number }>;
  };
  /** `/replay [N]` archived-plan payload — display-only, NEVER executed. */
  replayPlan?: {
    summary?: string | undefined;
    body?: string | undefined;
    steps: PlanStep[];
    completedStepIds: string[];
    completedAt: string;
    relativeTime: string;
    archiveBasename: string;
    /** 1-based index in `/plans` listing — surfaced in the header. */
    index: number;
    /** Total archives at the time of the lookup; helps the user navigate. */
    total: number;
  };
}

export type PlanModeToggleSource = "slash";

export interface SlashContext {
  configPath?: string | undefined;
  mcpSpecs?: string[] | undefined;
  codeUndo?: ((args: readonly string[]) => string | undefined) | undefined;
  codeApply?: ((indices?: readonly number[]) => string | undefined) | undefined;
  codeDiscard?: ((indices?: readonly number[]) => string | undefined) | undefined;
  codeHistory?: (() => string | undefined) | undefined;
  codeShowEdit?: ((args: readonly string[]) => string | undefined) | undefined;
  codeRoot?: string | undefined;
  pendingEditCount?: number | undefined;
  mcpServers?: McpServerSummary[] | undefined;
  /** Absent → tests context; `/memory` MUST reply "root unknown" rather than silently reading wrong dir. */
  memoryRoot?: string | undefined;
  /** Override `~/.reasonix` lookup root — production leaves this absent (defaults to `os.homedir()`); tests inject a tmpdir so they don't read the dev's real global memory. */
  homeDir?: string | undefined;
  planMode?: boolean | undefined;
  editMode?: EditMode | undefined;
  setEditMode?: ((mode: EditMode) => void) | undefined;
  touchedFiles?: (() => string[] | undefined) | undefined;
  /** stop_job is async; handlers return synchronously and let the registry resolve in the background. */
  jobs?: JobRegistry | undefined;
  postInfo?: ((text: string) => void) | undefined;
  /** Push a structured Doctor card with check-by-check status; used by `/doctor`. */
  postDoctor?: (
    checks: ReadonlyArray<{
      label: string;
      level: "ok" | "info" | "warn" | "fail";
      detail: string;
    }>,
  ) => void;
  /** Push a verbose Usage card (full bars) — used by `/cost`; auto-emitted per-turn cards stay compact. */
  postUsage?: (args: {
    turn: number;
    promptTokens: number;
    reasonTokens: number;
    outputTokens: number;
    promptCap: number;
    cacheHit: number;
    cost: number;
    sessionCost: number;
    balance?: number | undefined;
    balanceCurrency?: string | undefined;
    elapsedMs?: number | undefined;
  }) => void;
  /** Push the keyboard + mouse + copy/paste reference TipCard (multi-section). Used by `/keys`. */
  postKeys?: (args: {
    topic: string;
    sections: ReadonlyArray<{
      title?: string | undefined;
      rows: ReadonlyArray<{ key: string; text: string }>;
    }>;
    footer?: string | undefined;
  }) => void;
  dispatch?: ((event: import("../state/events.js").AgentEvent) => void) | undefined;
  setPlanMode?: ((on: boolean, source?: PlanModeToggleSource) => void) | undefined;
  /** Manual escape valve when the model forgot to call `mark_step_complete` — used by `/plans done <id>`. */
  markPlanStepDone?:
    | ((stepId: string) => "ok" | "not-in-plan" | "already-done" | "no-plan" | undefined)
    | undefined;
  /** Mark every still-queued step done — used by `/plans done all`. Returns the count newly marked. */
  markAllPlanStepsDone?: (() => number | undefined) | undefined;

  reloadHooks?: (() => number | undefined) | undefined;
  /** Switch the workspace root mid-session — re-targets filesystem/shell/memory tools, hooks, at-mention walker. Code mode only. `clear` mirrors `/new` (drops in-memory history + UI cards) so the previous workspace's chat doesn't contaminate the new one. */
  switchCwd?:
    | ((newPath: string) => { ok: boolean; info: string; clear?: boolean | undefined })
    | undefined;
  /** Diff config.mcp[] vs live bridges → add/close clients accordingly. Wired from chat.tsx mcpRuntime. */
  reloadMcp?:
    | (() => Promise<{
        added: string[];
        removed: string[];
        failed: Array<{ spec: string; reason: string }>;
        summaries: McpServerSummary[];
      }>)
    | undefined;
  mcpRuntime?:
    | {
        refilter: () => Promise<{ added: string[]; removed: string[] }>;
      }
    | undefined;
  /** `null` → still in flight OR offline; consumers can't distinguish, so always offer `refreshLatestVersion`. */
  latestVersion?: string | null | undefined;
  refreshLatestVersion?: (() => void) | undefined;
  /** `null` → in flight / failed; `[]` → API answered empty. `/model <id>` warn-only since list can lag. */
  models?: string[] | null | undefined;
  refreshModels?: (() => void) | undefined;
  /** Ask the current model to summarize the active session into a short title and rename it. */
  generateSessionTitle?: (() => Promise<string>) | undefined;
  armPro?: (() => void) | undefined;
  disarmPro?: (() => void) | undefined;
  startLoop?: ((intervalMs: number, prompt: string) => void) | undefined;
  stopLoop?: (() => void) | undefined;
  getLoopStatus?: () => {
    prompt: string;
    intervalMs: number;
    iter: number;
    nextFireMs: number;
  } | null;
  startWalkthrough?: (() => string | undefined) | undefined;
  startDashboard?: (() => Promise<string>) | undefined;
  /** Tear the dashboard server down. Mirrors stopLoop's shape; no-op when not running. */
  stopDashboard?: (() => Promise<void> | undefined) | undefined;
  /** Snapshot the dashboard's URL when running, null otherwise. */
  getDashboardUrl?: (() => string | null | undefined) | undefined;
  qq?: {
    connect: (args: readonly string[]) => Promise<string>;
    disconnect: () => Promise<string>;
    status: () => string;
  };
  /** Current session id — included in `/feedback`'s diagnostic block when present. */
  sessionId?: string | undefined;
}

export type SlashGroup =
  | "chat"
  | "setup"
  | "info"
  | "session"
  | "extend"
  | "code"
  | "jobs"
  | "advanced";

export interface SlashCommandSpec {
  cmd: string;
  summary: string;
  contextual?: "code" | undefined;
  /** Visual category in the suggestions palette + /help. `advanced` collapses by default. */
  group: SlashGroup;
  /** If the command takes args, hint text shown after the name. */
  argsHint?: string | undefined;
  /** First-arg picker source. `"path"` async-lists the filesystem for directory completion (used by `/cwd`). */
  argCompleter?:
    | "models"
    | "mcp-resources"
    | "mcp-prompts"
    | "skills"
    | "path"
    | readonly string[]
    | undefined;
  /** Alternate names — typing any of these resolves to `cmd` for dispatch / suggestion / arg-context. */
  aliases?: readonly string[] | undefined;
}

export interface SlashArgContext {
  spec: SlashCommandSpec;
  partial: string;
  partialOffset: number;
  kind: "picker" | "hint";
}

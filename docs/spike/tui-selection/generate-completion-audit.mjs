#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const verifierScript = resolve(scriptDir, "verify-manual-evidence.mjs");

const implementationChecks = [
  [
    "mouse-mode snapshot/subscription",
    "src/cli/ui/mouse-mode.ts",
    /subscribeMouseMode|getMouseModeSnapshot|toggleMouseMode/s,
  ],
  ["stdin parser reset", "src/cli/ui/stdin-reader.ts", /resetParseState/s],
  [
    "inactive mouse event guard",
    "src/cli/ui/stdin-reader.ts",
    /isMouseModeActive|mouseModeActive/s,
  ],
  ["/mouse slash handler", "src/cli/ui/slash/handlers/basic.ts", /mouse.*toggle|toggleMouseMode/s],
  ["/mouse command registry", "src/cli/ui/slash/commands.ts", /mouse/s],
  ["/help mouse restore hint", "tests/slash.test.ts", /help.*\/mouse.*native drag-select/s],
  ["Alt+M binding", "src/cli/ui/App.tsx", /alt.*m|Alt\+M/s],
  ["status row mouse segment", "src/cli/ui/layout/StatusRow.tsx", /mouse:on|mouseMode/s],
  ["unconditional chat cleanup", "src/cli/commands/chat.tsx", /disableMouseMode/s],
  ["unconditional code cleanup", "src/cli/commands/code.tsx", /disableMouseMode.*SIGTERM/s],
  [
    "mouse clipboard hint state flag",
    "src/config.ts",
    /mouseClipboardHintFlagPath|seen-mouse-hint\.flag/s,
  ],
  [
    "mouse clipboard first-run tip",
    "src/cli/ui/App.tsx",
    /tipMouseClipboard|markMouseClipboardHintShown/s,
  ],
  ["sliceCells helper", "src/frame/width.ts", /export function sliceCells/s],
  [
    "CopyMode cell selection module",
    "src/cli/ui/copy-mode/cell-selection.ts",
    /yankCellSelection|cellRangeForWord/s,
  ],
  [
    "CopyMode mouse events",
    "src/cli/ui/copy-mode/CopyMode.tsx",
    /mouseClick|mouseDrag|mouseRelease/s,
  ],
  [
    "CopyMode lost-release fallback",
    "src/cli/ui/copy-mode/CopyMode.tsx",
    /lost|release.*timeout|setTimeout/s,
  ],
  ["CopyMode performance test", "tests/copy-mode-perf.test.tsx", /mouseDrag|1000-line/s],
  [
    "CopyMode mouse test",
    "tests/copy-mode-mouse.test.tsx",
    /double-click|triple-click|mouse selection/s,
  ],
  [
    "spike script regression test",
    "tests/tui-selection-spike-scripts.test.ts",
    /verify-manual-evidence|generate-completion-audit|collect-local-evidence/s,
  ],
];

const artifactChecks = [
  ["E0 report", "docs/spike/tui-selection/E0-report.md"],
  ["E1 report", "docs/spike/tui-selection/E1-report.md"],
  ["E2 report", "docs/spike/tui-selection/E2-report.md"],
  ["E3 report", "docs/spike/tui-selection/E3-report.md"],
  ["E4 report", "docs/spike/tui-selection/E4-report.md"],
  ["E5 report", "docs/spike/tui-selection/E5-report.md"],
  ["E6 brief", "docs/spike/tui-selection/E6-user-research-brief.md"],
  ["manual checklist", "docs/spike/tui-selection/manual-terminal-checklist.md"],
  ["GUI automation capability report", "docs/spike/tui-selection/gui-automation-capability.md"],
  ["manual evidence template", "docs/spike/tui-selection/manual-evidence.template.json"],
  ["manual evidence verifier", "docs/spike/tui-selection/verify-manual-evidence.mjs"],
];

const planChecks = [
  ["research spike current status", "docs/plans/2026-05-26-tui-selection-research-spike.md"],
  ["v1 RAL plan lint", "docs/plans/2026-05-26-tui-text-selection-restore-borrow-ral.md"],
  ["v2 RAL plan lint", "docs/plans/2026-05-26-tui-text-selection-restore-v2-borrow-ral.md"],
];

if (process.argv.includes("--self-test")) {
  const rows = [{ status: "PASS" }, { status: "PASS" }, { status: "MISSING" }];
  assert.equal(countStatus(rows, "PASS"), 2);
  assert.equal(overallStatus([], { status: "PASS" }), "INCOMPLETE");
  assert.equal(overallStatus([{ status: "PASS" }], { status: "PASS" }), "COMPLETE_CANDIDATE");
  assert.equal(overallStatus([{ status: "PASS" }], { status: "INCOMPLETE" }), "INCOMPLETE");
  assert.equal(spikePlanStatus("GUI/manual matrix 仍未完成").status, "INCOMPLETE");
  assert.equal(spikePlanStatus("Spike 完成 = reports + plan v3").status, "PASS");
  process.stdout.write("self-test ok\n");
  process.exit(0);
}

const manualEvidenceFile = firstNonFlagArg(process.argv.slice(2));
const failOnIncomplete = process.argv.includes("--fail-on-incomplete");
const plans = planChecks.map(([label, file]) => checkPlan(label, file));
const implementation = implementationChecks.map(([label, file, pattern]) =>
  checkPattern(label, file, pattern),
);
const artifacts = artifactChecks.map(([label, file]) => checkExists(label, file));
const manual = runManualVerifier(manualEvidenceFile);
const allRows = [...plans, ...implementation, ...artifacts];
const status = overallStatus(allRows, manual);

process.stdout.write(renderMarkdown({ status, plans, implementation, artifacts, manual }));
if (failOnIncomplete && status !== "COMPLETE_CANDIDATE") process.exit(1);

function checkPlan(label, file) {
  if (label === "research spike current status") return checkResearchSpikePlan(label, file);
  const abs = resolve(repoRoot, file);
  if (!existsSync(abs)) return { label, status: "MISSING", evidence: file };
  const child = spawnSync("bash", ["bin/plan-lint.sh", file], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    label,
    status: child.status === 0 ? "PASS" : "FAIL",
    evidence: file,
    output: `${child.stdout ?? ""}${child.stderr ?? ""}`.trim(),
  };
}

function checkResearchSpikePlan(label, file) {
  const abs = resolve(repoRoot, file);
  if (!existsSync(abs)) return { label, status: "MISSING", evidence: file };
  const status = spikePlanStatus(readFileSync(abs, "utf8"));
  return {
    label,
    status: status.status,
    evidence: `${file} (${status.evidence})`,
  };
}

function spikePlanStatus(text) {
  if (
    /GUI\/manual matrix 仍未完成|manual terminal matrix.*incomplete|still incomplete/s.test(text)
  ) {
    return { status: "INCOMPLETE", evidence: "declares missing GUI/manual matrix" };
  }
  if (/Spike 完成|COMPLETE_CANDIDATE|Status: COMPLETE/s.test(text)) {
    return { status: "PASS", evidence: "declares completion path" };
  }
  return { status: "FAIL", evidence: "does not declare current spike status" };
}

function checkPattern(label, file, pattern) {
  const abs = resolve(repoRoot, file);
  if (!existsSync(abs)) return { label, status: "MISSING", evidence: file };
  const text = readFileSync(abs, "utf8");
  return {
    label,
    status: pattern.test(text) ? "PASS" : "FAIL",
    evidence: file,
  };
}

function checkExists(label, file) {
  const abs = resolve(repoRoot, file);
  return {
    label,
    status: existsSync(abs) ? "PASS" : "MISSING",
    evidence: file,
  };
}

function runManualVerifier(file) {
  if (!file) {
    return {
      label: "manual evidence verifier",
      status: "MISSING",
      evidence: "no manual-evidence.json provided",
      output: "",
    };
  }
  const abs = resolve(file);
  if (!existsSync(abs)) {
    return {
      label: "manual evidence verifier",
      status: "MISSING",
      evidence: abs,
      output: "",
    };
  }
  const child = spawnSync(process.execPath, [verifierScript, abs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    label: "manual evidence verifier",
    status: child.status === 0 ? "PASS" : "INCOMPLETE",
    evidence: abs,
    output: `${child.stdout ?? ""}${child.stderr ?? ""}`.trim(),
  };
}

function renderMarkdown({ status, plans, implementation, artifacts, manual }) {
  const lines = [];
  lines.push("# TUI Selection Completion Audit");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Status: ${status}`);
  lines.push("");
  lines.push(
    "This audit is evidence-only. `COMPLETE_CANDIDATE` still requires a fresh final verification run such as `npm run verify` before the thread goal can be marked complete.",
  );
  lines.push("");
  lines.push("## Plan Evidence");
  lines.push("");
  lines.push("| Check | Status | Evidence |");
  lines.push("|---|---|---|");
  for (const row of plans) lines.push(markdownRow(row));
  const planOutputs = plans.filter((row) => row.output);
  if (planOutputs.length > 0) {
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>plan-lint output</summary>");
    lines.push("");
    lines.push("```text");
    for (const row of planOutputs) {
      lines.push(`$ ${row.label}`);
      lines.push(row.output);
      lines.push("");
    }
    lines.push("```");
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  lines.push("## Implementation Evidence");
  lines.push("");
  lines.push("| Check | Status | Evidence |");
  lines.push("|---|---|---|");
  for (const row of implementation) lines.push(markdownRow(row));
  lines.push("");
  lines.push("## Spike Artifact Evidence");
  lines.push("");
  lines.push("| Artifact | Status | Evidence |");
  lines.push("|---|---|---|");
  for (const row of artifacts) lines.push(markdownRow(row));
  lines.push("");
  lines.push("## Manual Evidence Gate");
  lines.push("");
  lines.push("| Check | Status | Evidence |");
  lines.push("|---|---|---|");
  lines.push(markdownRow(manual));
  if (manual.output) {
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>manual verifier output</summary>");
    lines.push("");
    lines.push("```text");
    lines.push(manual.output);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Plan checks: ${countStatus(plans, "PASS")}/${plans.length} PASS.`);
  lines.push(
    `- Implementation checks: ${countStatus(implementation, "PASS")}/${implementation.length} PASS.`,
  );
  lines.push(`- Spike artifacts: ${countStatus(artifacts, "PASS")}/${artifacts.length} PASS.`);
  lines.push(`- Manual evidence: ${manual.status}.`);
  lines.push("");
  if (status !== "COMPLETE_CANDIDATE") {
    lines.push("Remaining completion blockers:");
    lines.push("");
    if (plans.some((row) => row.status !== "PASS")) {
      lines.push("- One or more plan evidence checks are incomplete or failing.");
    }
    if (implementation.some((row) => row.status !== "PASS")) {
      lines.push("- One or more implementation evidence checks are missing or failing.");
    }
    if (artifacts.some((row) => row.status !== "PASS")) {
      lines.push("- One or more spike artifacts are missing.");
    }
    if (manual.status !== "PASS") {
      lines.push("- Manual GUI evidence has not passed `verify-manual-evidence.mjs`.");
    }
  }
  return `${lines.join("\n")}\n`;
}

function markdownRow(row) {
  return `| ${escapeCell(row.label)} | ${row.status} | ${escapeCell(row.evidence)} |`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function countStatus(rows, status) {
  return rows.filter((row) => row.status === status).length;
}

function overallStatus(rows, manual) {
  return rows.length > 0 && rows.every((row) => row.status === "PASS") && manual.status === "PASS"
    ? "COMPLETE_CANDIDATE"
    : "INCOMPLETE";
}

function firstNonFlagArg(args) {
  return args.find((arg) => !arg.startsWith("--")) ?? "";
}

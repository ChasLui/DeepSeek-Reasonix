import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SPIKE_DIR = resolve("docs/spike/tui-selection");
const NODE_SCRIPTS = [
  "e0-selection-probe.mjs",
  "e4-key-probe.mjs",
  "fr104-row-offset-probe.mjs",
  "verify-manual-evidence.mjs",
  "generate-completion-audit.mjs",
];

describe("TUI selection spike scripts", () => {
  for (const script of NODE_SCRIPTS) {
    it(`${script} parses and passes its self-test`, () => {
      run(process.execPath, ["--check", join(SPIKE_DIR, script)]);
      run(process.execPath, [join(SPIKE_DIR, script), "--self-test"]);
    });
  }

  it("manual evidence template remains valid JSON with the expected schema", () => {
    const data = JSON.parse(readFileSync(join(SPIKE_DIR, "manual-evidence.template.json"), "utf8"));
    expect(data.schemaVersion).toBe(1);
    expect(data.requirements.minE3Rows).toBe(12);
    expect(data.requirements.minE4Rows).toBe(30);
    expect(data.requirements.minFr104Rows).toBe(7);
    expect(data.pathEConsidered).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "collect-local-evidence produces manual evidence and an incomplete audit without GUI rows",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "reasonix-tui-selection-test-"));
      try {
        run(
          "bash",
          [join(SPIKE_DIR, "collect-local-evidence.sh")],
          {
            OUT_DIR: outDir,
            SKIP_INTERACTIVE: "1",
          },
          60_000,
        );
        const manualEvidence = join(outDir, "manual-evidence.json");
        const audit = join(outDir, "completion-audit.md");
        expect(existsSync(manualEvidence)).toBe(true);
        expect(existsSync(join(outDir, "gui-capability.md"))).toBe(true);
        expect(existsSync(join(outDir, "e3-render-samples/combined.ansi"))).toBe(true);
        expect(readFileSync(manualEvidence, "utf8")).toContain(outDir);
        expect(readFileSync(audit, "utf8")).toContain("Status: INCOMPLETE");
        expect(readFileSync(audit, "utf8")).toContain("## Plan Evidence");
        expect(readFileSync(audit, "utf8")).toContain("research spike current status");
        expect(readFileSync(audit, "utf8")).toContain(
          "E0 includes same-row default native /mouse on /mouse off contrast",
        );
        expect(readFileSync(audit, "utf8")).toContain("E4 includes local/ssh/tmux contexts");
        expect(readFileSync(audit, "utf8")).toContain("FR-104 includes local/ssh/tmux contexts");
        expect(readFileSync(audit, "utf8")).toContain("Manual GUI evidence has not passed");
      } finally {
        rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    70_000,
  );
});

function run(
  command: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 20_000,
): void {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout,
  });
  expect(
    result.status,
    `${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

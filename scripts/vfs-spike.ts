#!/usr/bin/env tsx
// Gate A spike: compare just-bash VFS output vs real spawn for 12 candidate commands.
// Outputs: scripts/vfs-spike-report.md with per-command byte-identical hit rate.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — runtime import, types may not be precise
import { Bash, OverlayFs } from "just-bash";

interface Probe {
  cmd: string;
  // If the command needs to be normalized for comparison (e.g. strip leading /
  // from paths because just-bash uses absolute mount paths), pass a transform.
  normalize?: (out: string) => string;
}

const PROBES: Record<string, Probe[]> = {
  ls: [
    { cmd: "ls {ROOT}/package.json" },
    { cmd: "ls {ROOT}/README.md" },
    { cmd: "ls {ROOT}/src" },
    { cmd: "ls {ROOT}/tests" },
    { cmd: "ls {ROOT}/.gitignore" },
  ],
  cat: [
    { cmd: "cat {ROOT}/package.json" },
    { cmd: "cat {ROOT}/.gitignore" },
    { cmd: "cat {ROOT}/README.md" },
    { cmd: "cat {ROOT}/tsconfig.json" },
    { cmd: "cat {ROOT}/biome.json" },
  ],
  head: [
    { cmd: "head -1 {ROOT}/package.json" },
    { cmd: "head -5 {ROOT}/README.md" },
    { cmd: "head -3 {ROOT}/.gitignore" },
    { cmd: "head -10 {ROOT}/tsconfig.json" },
    { cmd: "head -2 {ROOT}/biome.json" },
  ],
  tail: [
    { cmd: "tail -1 {ROOT}/package.json" },
    { cmd: "tail -5 {ROOT}/README.md" },
    { cmd: "tail -3 {ROOT}/.gitignore" },
    { cmd: "tail -10 {ROOT}/tsconfig.json" },
    { cmd: "tail -2 {ROOT}/biome.json" },
  ],
  wc: [
    { cmd: "wc -l {ROOT}/package.json" },
    { cmd: "wc -l {ROOT}/README.md" },
    { cmd: "wc -l {ROOT}/.gitignore" },
    { cmd: "wc -c {ROOT}/package.json" },
    { cmd: "wc -w {ROOT}/README.md" },
  ],
  grep: [
    { cmd: 'grep "name" {ROOT}/package.json' },
    { cmd: 'grep -n "TODO" {ROOT}/README.md' },
    { cmd: 'grep -c "import" {ROOT}/src/tools.ts' },
    { cmd: 'grep "scripts" {ROOT}/package.json' },
    { cmd: 'grep -i "license" {ROOT}/package.json' },
  ],
  find: [
    { cmd: "find {ROOT}/src -name *.ts -type f -maxdepth 1" },
    { cmd: "find {ROOT}/src/repair -name *.ts -type f" },
    { cmd: 'find {ROOT} -maxdepth 1 -name "package.json"' },
    { cmd: 'find {ROOT}/tests -name "*.test.ts" -maxdepth 1' },
    { cmd: "find {ROOT}/src/compact -type f" },
  ],
  echo: [
    { cmd: "echo hello" },
    { cmd: 'echo "hello world"' },
    { cmd: "echo $HOME" },
    { cmd: "echo a b c" },
    { cmd: "echo -n no-newline" },
  ],
  printf: [
    { cmd: 'printf "%s\\n" hello' },
    { cmd: 'printf "%d %d\\n" 1 2' },
    { cmd: 'printf "%-10s|%s\\n" a b' },
    { cmd: 'printf "no-newline"' },
    { cmd: 'printf "%s\\n" a b c' },
  ],
  stat: [
    { cmd: "stat {ROOT}/package.json" },
    { cmd: "stat {ROOT}/.gitignore" },
    { cmd: "stat {ROOT}/src" },
    { cmd: "stat {ROOT}/README.md" },
    { cmd: "stat -c %s {ROOT}/package.json" },
  ],
  which: [
    { cmd: "which ls" },
    { cmd: "which cat" },
    { cmd: "which node" },
    { cmd: "which git" },
    { cmd: "which nonexistent" },
  ],
  file: [
    { cmd: "file {ROOT}/package.json" },
    { cmd: "file {ROOT}/README.md" },
    { cmd: "file {ROOT}/src" },
    { cmd: "file {ROOT}/.gitignore" },
    { cmd: "file {ROOT}/biome.json" },
  ],
};

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function realSpawn(cmd: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", cmd], {
      cwd,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

async function vfsRun(bash: any, cmd: string): Promise<RunResult> {
  try {
    const r = await bash.exec(cmd);
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? -1,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: `[vfs-exception: ${(err as Error).message}]`,
      exitCode: -1,
    };
  }
}

// Strip absolute /mount path prefix added by OverlayFs and trim ANSI/trailing whitespace.
function normalize(s: string, root: string): string {
  return s.replaceAll(root, "").replaceAll("/", "").trim();
}

async function main() {
  const root = process.cwd();
  // mountPoint = root so VFS virtual paths align with real fs absolute paths.
  // Otherwise VFS sees `/package.json` while real bash sees `<root>/package.json`.
  const fs = new OverlayFs({ root, mountPoint: root });
  const bash = new Bash({
    fs,
    env: { HOME: root, PWD: root, LC_ALL: "C", TZ: "UTC" },
    cwd: root,
  });
  // Resolve {ROOT} placeholders in each probe to the absolute root path.
  for (const probes of Object.values(PROBES)) {
    for (const p of probes) p.cmd = p.cmd.replaceAll("{ROOT}", root);
  }

  const lines: string[] = [];
  lines.push("# Gate A — VFS byte-identical hit rate report\n");
  lines.push(`Root: \`${root}\`  · Date: ${new Date().toISOString()}\n`);
  lines.push("| Command | Variants | Exact | StdoutMatch | ExitMatch | Notes |");
  lines.push("|---|---|---|---|---|---|");

  let totalProbes = 0;
  let totalExact = 0;
  let totalStdoutMatch = 0;

  for (const [tool, probes] of Object.entries(PROBES)) {
    let exact = 0;
    let stdoutOk = 0;
    let exitOk = 0;
    const notes: string[] = [];
    for (const p of probes) {
      totalProbes++;
      const real = await realSpawn(p.cmd, root);
      const vfs = await vfsRun(bash, p.cmd);
      const exitMatch = real.exitCode === vfs.exitCode;
      // Compare stdout byte-identical (strict) and after normalization
      const exactMatch = real.stdout === vfs.stdout && real.exitCode === vfs.exitCode;
      const normMatch = normalize(real.stdout, root) === normalize(vfs.stdout, root);
      if (exactMatch) exact++;
      if (normMatch) stdoutOk++;
      if (exitMatch) exitOk++;
      if (!exactMatch && notes.length < 2) {
        const realPrev = JSON.stringify(real.stdout.slice(0, 50));
        const vfsPrev = JSON.stringify(vfs.stdout.slice(0, 50));
        notes.push(`\`${p.cmd}\`: real=${realPrev} vfs=${vfsPrev}`);
      }
    }
    totalExact += exact;
    totalStdoutMatch += stdoutOk;
    lines.push(
      `| ${tool} | ${probes.length} | ${exact}/${probes.length} | ${stdoutOk}/${probes.length} | ${exitOk}/${probes.length} | ${notes.join("; ") || "—"} |`,
    );
  }

  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total probes**: ${totalProbes}`);
  lines.push(
    `- **Strict byte-identical**: ${totalExact}/${totalProbes} = ${((totalExact / totalProbes) * 100).toFixed(1)}%`,
  );
  lines.push(
    `- **Normalized stdout match**: ${totalStdoutMatch}/${totalProbes} = ${((totalStdoutMatch / totalProbes) * 100).toFixed(1)}%`,
  );
  lines.push("");
  lines.push("## Gate A verdict (threshold ≥ 70% strict byte-identical)");
  lines.push("");
  const pass = totalExact / totalProbes >= 0.7;
  lines.push(
    pass
      ? "✅ **PASS** — proceed to Task 2"
      : "❌ **FAIL** — plan收缩到 Task 4 + Task 5 (no just-bash dep)",
  );

  const reportPath = join(root, "scripts/vfs-spike-report.md");
  writeFileSync(reportPath, `${lines.join("\n")}\n`);
  console.log(lines.slice(0, 30).join("\n"));
  console.log(`\n[Report written to ${reportPath}]`);
}

main().catch((err) => {
  console.error("Spike crashed:", err);
  process.exit(1);
});

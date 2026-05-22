/** VFS-Lite — pure-Node reimplementation of read-only POSIX commands whose output is
 * byte-identical to coreutils. Whitelisted commands only; first throw → sticky spawn fallback. */

import { promises as fs } from "node:fs";
import * as pathMod from "node:path";
import { nullPrototype } from "../../utils/safe-object.js";
import type { RunCommandResult } from "./exec.js";
import { tokenizeCommand } from "./parse.js";

/** Commands handled by VFS-Lite. Adding a name here means it MUST be byte-identical
 *  to the system binary — verify with scripts/vfs-spike.ts before promoting. */
export const VFS_LITE_COMMANDS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "printf",
  "echo",
  "pwd",
  "true",
  "false",
  "basename",
  "dirname",
]);

/** Per-session blacklist — once a command throws under VFS-Lite, it falls back
 *  to spawn for the rest of the session so output shape stays consistent. */
const vfsBlacklistedThisSession = new Set<string>();

export function isVfsBlacklisted(command: string): boolean {
  return vfsBlacklistedThisSession.has(command);
}

export function markVfsFallback(command: string): void {
  vfsBlacklistedThisSession.add(command);
}

export function resetVfsState(): void {
  vfsBlacklistedThisSession.clear();
}

export interface VfsStats {
  hits: Record<string, number>;
  fallbacks: Record<string, number>;
}

const stats: VfsStats = { hits: {}, fallbacks: {} };

export function getVfsStats(): VfsStats {
  return { hits: { ...stats.hits }, fallbacks: { ...stats.fallbacks } };
}

export function resetVfsStats(): void {
  for (const k of Object.keys(stats.hits)) delete stats.hits[k];
  for (const k of Object.keys(stats.fallbacks)) delete stats.fallbacks[k];
}

function bumpHit(command: string): void {
  stats.hits[command] = (stats.hits[command] ?? 0) + 1;
}

function bumpFallback(command: string): void {
  stats.fallbacks[command] = (stats.fallbacks[command] ?? 0) + 1;
}

/** True when `argv` can safely run under VFS-Lite. Conservative — flags we don't
 *  understand or shell features (pipes, redirects, secondary execution) all return
 *  false so the caller falls back to spawn. */
export function canRunInVfs(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const head = argv[0]!;
  if (!VFS_LITE_COMMANDS.has(head)) return false;
  if (isVfsBlacklisted(head)) return false;
  // Shell metasyntax (pipes / redirects / chains) is already split out by
  // shell-chain.ts before we reach this layer. We only need to bail on
  // command-specific secondary-execution flags.
  for (const a of argv.slice(1)) {
    if (a === "-exec" || a === "-execdir" || a === "xargs") return false;
  }
  return true;
}

type CommandHandler = (argv: readonly string[], opts: RunOpts) => Promise<RunCommandResult>;

interface RunOpts {
  cwd: string;
  rootDir: string;
}

const HANDLERS: Record<string, CommandHandler> = nullPrototype({
  cat: catCommand,
  head: headCommand,
  tail: tailCommand,
  printf: printfCommand,
  echo: echoCommand,
  pwd: pwdCommand,
  true: trueCommand,
  false: falseCommand,
  basename: basenameCommand,
  dirname: dirnameCommand,
});

async function echoCommand(argv: readonly string[]): Promise<RunCommandResult> {
  // POSIX/BSD echo: -n suppresses trailing newline. Anything else is data.
  // We do NOT expand $VAR — that's the shell's job, and our argv comes
  // already tokenized + literal from `tokenizeCommand`.
  const args = argv.slice(1);
  let newline = true;
  let i = 0;
  if (args[0] === "-n") {
    newline = false;
    i = 1;
  }
  const body = args.slice(i).join(" ");
  return { exitCode: 0, output: body + (newline ? "\n" : ""), timedOut: false };
}

async function pwdCommand(_argv: readonly string[], opts: RunOpts): Promise<RunCommandResult> {
  // `pwd` outputs the absolute cwd. Both bash builtin and /bin/pwd produce
  // `<cwd>\n` — we mirror that exactly.
  return { exitCode: 0, output: `${opts.cwd}\n`, timedOut: false };
}

async function trueCommand(): Promise<RunCommandResult> {
  return { exitCode: 0, output: "", timedOut: false };
}

async function falseCommand(): Promise<RunCommandResult> {
  return { exitCode: 1, output: "", timedOut: false };
}

async function basenameCommand(argv: readonly string[]): Promise<RunCommandResult> {
  // `basename PATH [SUFFIX]` — strip dirs, optionally strip a trailing suffix.
  const args = argv.slice(1);
  if (args.length === 0 || args.length > 2) {
    throw new Error("vfs basename: usage basename PATH [SUFFIX]");
  }
  for (const a of args) {
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`vfs basename: unsupported flag ${a}`);
    }
  }
  let result = pathMod.basename(args[0]!);
  const suffix = args[1];
  if (suffix && result.endsWith(suffix) && result !== suffix) {
    result = result.slice(0, -suffix.length);
  }
  return { exitCode: 0, output: `${result}\n`, timedOut: false };
}

async function dirnameCommand(argv: readonly string[]): Promise<RunCommandResult> {
  const args = argv.slice(1);
  if (args.length === 0) {
    throw new Error("vfs dirname: usage dirname PATH");
  }
  for (const a of args) {
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`vfs dirname: unsupported flag ${a}`);
    }
  }
  // GNU dirname accepts multiple args (outputs each on its own line);
  // BSD only takes one. We support both — single-line for one arg,
  // multi-line for many. Matches bash on both platforms in the common case.
  const lines = args.map((p) => pathMod.dirname(p));
  return { exitCode: 0, output: `${lines.join("\n")}\n`, timedOut: false };
}

/** Run `argv` under VFS-Lite. Returns `null` to mean "VFS can't handle it — caller should spawn".
 *  Throws are caught and turned into a fallback signal so dispatch logic stays simple. */
export async function runInVfs(cmd: string, opts: RunOpts): Promise<RunCommandResult | null> {
  const argv = tokenizeCommand(cmd);
  if (!canRunInVfs(argv)) return null;
  const handler = HANDLERS[argv[0]!];
  if (!handler) return null;
  try {
    const result = await handler(argv, opts);
    bumpHit(argv[0]!);
    return result;
  } catch (err) {
    // Sticky fallback: don't try this command in VFS for the rest of the session.
    markVfsFallback(argv[0]!);
    bumpFallback(argv[0]!);
    return null;
  }
}

/** Resolve a path the way bash would when given an absolute or relative arg. */
function resolveArg(arg: string, cwd: string): string {
  return pathMod.isAbsolute(arg) ? arg : pathMod.join(cwd, arg);
}

async function catCommand(argv: readonly string[], opts: RunOpts): Promise<RunCommandResult> {
  // GNU/BSD cat: any flag we don't support → bail to spawn.
  const files: string[] = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`vfs cat: unsupported flag ${a}`);
    }
    files.push(a);
  }
  if (files.length === 0) {
    // Bare `cat` reads stdin — we don't have a stdin pipe here. Fall back.
    throw new Error("vfs cat: stdin form unsupported");
  }
  let output = "";
  let lastErr: string | null = null;
  let exit = 0;
  for (const f of files) {
    const abs = resolveArg(f, opts.cwd);
    try {
      output += await fs.readFile(abs, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      exit = 1;
      const reason = e.code === "ENOENT" ? "No such file or directory" : e.message;
      lastErr = `cat: ${f}: ${reason}\n`;
    }
  }
  return {
    exitCode: exit,
    output: output + (lastErr ?? ""),
    timedOut: false,
  };
}

async function headCommand(argv: readonly string[], opts: RunOpts): Promise<RunCommandResult> {
  let n = 10;
  const files: string[] = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-n") {
      const v = rest[++i];
      if (v === undefined) throw new Error("vfs head: -n requires arg");
      const parsed = Number.parseInt(v, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("vfs head: invalid -n value");
      n = parsed;
      continue;
    }
    if (/^-\d+$/.test(a)) {
      n = Number.parseInt(a.slice(1), 10);
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`vfs head: unsupported flag ${a}`);
    }
    files.push(a);
  }
  if (files.length === 0) throw new Error("vfs head: stdin form unsupported");
  if (files.length > 1) throw new Error("vfs head: multi-file headers unsupported");
  const abs = resolveArg(files[0]!, opts.cwd);
  try {
    const body = await fs.readFile(abs, "utf8");
    const lines = body.split("\n");
    // `split("\n")` produces an extra empty entry when the body ends with "\n".
    // We want exactly the first N "lines" as cat sees them.
    const slice = lines.slice(0, n);
    // Rejoin with newlines so the trailing newline (when present) is preserved
    // for N <= total. When N >= total and body ends with "\n", the empty tail
    // entry yields "...\n" — matches GNU/BSD head behavior.
    const out = slice.join("\n") + (n < lines.length ? "\n" : "");
    return { exitCode: 0, output: out, timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      output: `head: ${files[0]}: ${e.code === "ENOENT" ? "No such file or directory" : e.message}\n`,
      timedOut: false,
    };
  }
}

async function tailCommand(argv: readonly string[], opts: RunOpts): Promise<RunCommandResult> {
  let n = 10;
  const files: string[] = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-n") {
      const v = rest[++i];
      if (v === undefined) throw new Error("vfs tail: -n requires arg");
      const parsed = Number.parseInt(v.replace(/^\+/, ""), 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("vfs tail: invalid -n value");
      n = parsed;
      continue;
    }
    if (/^-\d+$/.test(a)) {
      n = Number.parseInt(a.slice(1), 10);
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`vfs tail: unsupported flag ${a}`);
    }
    files.push(a);
  }
  if (files.length === 0) throw new Error("vfs tail: stdin form unsupported");
  if (files.length > 1) throw new Error("vfs tail: multi-file headers unsupported");
  const abs = resolveArg(files[0]!, opts.cwd);
  try {
    const body = await fs.readFile(abs, "utf8");
    if (n === 0) return { exitCode: 0, output: "", timedOut: false };
    const lines = body.split("\n");
    const endsWithNewline = body.endsWith("\n");
    // Split produces a trailing "" for files that end in "\n". Strip it so we
    // don't count it as a line for selection purposes, then re-add the newline
    // at the end of the output if appropriate.
    const real = endsWithNewline ? lines.slice(0, -1) : lines;
    const slice = real.slice(Math.max(0, real.length - n));
    const out = slice.join("\n") + (endsWithNewline && slice.length > 0 ? "\n" : "");
    return { exitCode: 0, output: out, timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      output: `tail: ${files[0]}: ${e.code === "ENOENT" ? "No such file or directory" : e.message}\n`,
      timedOut: false,
    };
  }
}

async function printfCommand(argv: readonly string[]): Promise<RunCommandResult> {
  const rest = argv.slice(1);
  if (rest.length === 0) throw new Error("vfs printf: format required");
  const fmt = rest[0]!;
  const args = rest.slice(1);
  // Only support the subset bash uses for tool output: `%s`, `%d`, `%-Ns`, `\n`, `\t`.
  // Anything else → fallback. The format is replayed until args are exhausted (matches
  // POSIX printf behavior).
  let out = "";
  let argIdx = 0;
  const replay = args.length === 0 ? 1 : Math.max(1, Math.ceil(args.length / countSpecs(fmt)));
  for (let pass = 0; pass < replay; pass++) {
    let i = 0;
    while (i < fmt.length) {
      const ch = fmt[i]!;
      if (ch === "\\" && i + 1 < fmt.length) {
        const next = fmt[++i]!;
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "\\") out += "\\";
        else if (next === '"') out += '"';
        else throw new Error(`vfs printf: unsupported escape \\${next}`);
        i++;
        continue;
      }
      if (ch === "%" && i + 1 < fmt.length) {
        // Parse optional width/precision
        let spec = "%";
        i++;
        while (i < fmt.length && /[-0-9.]/.test(fmt[i]!)) spec += fmt[i++];
        const kind = fmt[i++];
        spec += kind;
        if (kind === "%") {
          out += "%";
          continue;
        }
        if (kind === "s") {
          const v = args[argIdx++] ?? "";
          out += applyWidth(spec, v);
          continue;
        }
        if (kind === "d") {
          const raw = args[argIdx++] ?? "0";
          const n = Number.parseInt(raw, 10);
          out += applyWidth(spec, Number.isFinite(n) ? String(n) : "0");
          continue;
        }
        throw new Error(`vfs printf: unsupported spec ${spec}`);
      }
      out += ch;
      i++;
    }
    if (argIdx >= args.length) break;
  }
  return { exitCode: 0, output: out, timedOut: false };
}

function countSpecs(fmt: string): number {
  let count = 0;
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "%" && fmt[i + 1] !== "%" && i + 1 < fmt.length) {
      count++;
      i += 2;
      continue;
    }
    i++;
  }
  return Math.max(1, count);
}

function applyWidth(spec: string, value: string): string {
  const m = /^%(-?)(\d+)/.exec(spec);
  if (!m) return value;
  const leftAlign = m[1] === "-";
  const width = Number.parseInt(m[2]!, 10);
  if (value.length >= width) return value;
  const pad = " ".repeat(width - value.length);
  return leftAlign ? value + pad : pad + value;
}

/** Legacy `powershell.exe` / `cmd.exe` running under conhost — repaints each Ink frame visibly, unlike Windows Terminal's double-buffer. */
export function isLegacyWindowsConsole(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM;
}

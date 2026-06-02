/** systemd socket activation — detect a listening socket fd handed down by a .socket unit (LISTEN_FDS protocol). */

/** SD_LISTEN_FDS_START — systemd passes the first activated socket as fd 3. */
const SD_LISTEN_FDS_START = 3;

/** Returns the inherited listen fd when this process was socket-activated by systemd for THIS pid, else null (self-bind path). */
export function inheritedListenFd(env: NodeJS.ProcessEnv = process.env): number | null {
  const count = Number.parseInt(env.LISTEN_FDS ?? "", 10);
  if (!Number.isInteger(count) || count < 1) return null;
  // LISTEN_PID guards against the variables leaking to a child process.
  if (env.LISTEN_PID && env.LISTEN_PID !== String(process.pid)) return null;
  return SD_LISTEN_FDS_START;
}

/** Bind the daemon control socket and spin up one AcpServer per accepted connection. */

import { chmodSync, mkdirSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { AcpServer } from "../acp/server.js";
import { reasonixDir } from "../storage/path.js";
import type { DaemonHost } from "./host.js";

export function listenDaemon(host: DaemonHost, socketPath: string): Promise<Server> {
  mkdirSync(reasonixDir(), { recursive: true });
  const server = createServer((socket) => {
    const rpc = new AcpServer({ input: socket, output: socket });
    host.attach(rpc);
    let torn = false;
    const cleanup = (): void => {
      if (torn) return;
      torn = true;
      void host.detach(rpc);
      rpc.close();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      // UDS file perms restrict the control plane to the owning user (no token needed).
      if (process.platform !== "win32") {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          /* chmod unsupported on this platform */
        }
      }
      resolve(server);
    });
  });
}

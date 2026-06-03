/** Bind the daemon control socket and spin up one AcpServer per accepted connection. */

import { chmodSync, mkdirSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { AcpServer } from "../acp/server.js";
import { reasonixDir } from "../storage/path.js";
import type { DaemonHost } from "./host.js";
import { inheritedListenFd } from "./socket-activation.js";

export function listenDaemon(host: DaemonHost, socketPath: string): Promise<Server> {
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

  // systemd socket activation: the .socket unit already created + bound the
  // socket and passed us its fd. Listen on that — don't bind/chmod ourselves.
  const fd = inheritedListenFd();
  if (fd !== null) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ fd }, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });
  }

  mkdirSync(reasonixDir(), { recursive: true });
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

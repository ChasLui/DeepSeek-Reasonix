import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonHost } from "../src/daemon/host.js";
import { daemonStatusPayload, startStatusServer } from "../src/daemon/status-server.js";

afterEach(() => vi.unstubAllEnvs());

describe("daemonStatusPayload", () => {
  it("reports pid, version, uptime, and session summaries", () => {
    vi.stubEnv("REASONIX_FUSE", "0");
    const host = new DaemonHost({ defaultDir: "/tmp" });
    const payload = daemonStatusPayload(host, 1000, 4000);
    expect(payload.ok).toBe(true);
    expect(payload.pid).toBe(process.pid);
    expect(payload.uptimeMs).toBe(3000);
    expect(payload.sessions).toEqual([]);
    expect(payload.fuse).toMatchObject({ mode: "off", state: "disabled" });
  });

  it("includes per-workspace index status (empty when background indexing is disabled)", () => {
    const host = new DaemonHost({ defaultDir: "/tmp" });
    expect(daemonStatusPayload(host, 1000, 4000).index).toEqual([]);
  });
});

describe("startStatusServer", () => {
  it("serves /health and /status over loopback HTTP", async () => {
    vi.stubEnv("REASONIX_FUSE", "0");
    const host = new DaemonHost({ defaultDir: "/tmp" });
    const server = await startStatusServer(host, 0, Date.now());
    const port = (server.address() as AddressInfo).port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const status = await fetch(`http://127.0.0.1:${port}/status`);
      const body = (await status.json()) as {
        ok: boolean;
        pid: number;
        sessions: unknown[];
        fuse: { mode: string; state: string };
      };
      expect(body.ok).toBe(true);
      expect(body.pid).toBe(process.pid);
      expect(body.sessions).toEqual([]);
      expect(body.fuse).toMatchObject({ mode: "off", state: "disabled" });

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

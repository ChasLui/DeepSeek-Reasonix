/** RemoteLoop — presents the slice of the CacheFirstLoop surface the desktop reads, backed by a daemon session. Synchronous reads are served from a snapshot refreshed after each turn/mutation; step() proxies to the daemon's loopEvent stream. */

import type { LoopEvent } from "../loop/types.js";
import type { DaemonClient } from "./client.js";
import type { DaemonSessionStats } from "./host.js";

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export class RemoteLoop {
  budgetUsd: number | null;
  readonly prefix: { system: string; toolSpecs: unknown };
  readonly client: {
    getBalance(): Promise<unknown>;
    chat(opts: {
      model: string;
      messages: Array<{ role: string; content: string }>;
    }): Promise<{ content: string }>;
  };
  private logTokens: number;

  constructor(
    private readonly daemon: DaemonClient,
    readonly sessionId: string,
    private model: string,
    snapshot: DaemonSessionStats,
  ) {
    this.budgetUsd = snapshot.budgetUsd;
    this.logTokens = snapshot.logTokens;
    this.prefix = {
      system: snapshot.prefixSystem,
      toolSpecs: safeParse(snapshot.prefixToolSpecs),
    };
    this.client = {
      getBalance: () => this.daemon.balance(this.sessionId),
      chat: async (o) => ({
        content: await this.daemon.chat(this.sessionId, o.model, o.messages),
      }),
    };
  }

  /** Drive a turn in the daemon; yield the raw LoopEvents it streams (the desktop Eventizes them locally). */
  async *step(text: string): AsyncGenerator<LoopEvent> {
    const queue: LoopEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const done = this.daemon
      .prompt(this.sessionId, text, (ev) => {
        queue.push(ev);
        wake?.();
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
    await done;
    await this.refresh();
  }

  abort(): void {
    this.daemon.cancel(this.sessionId);
  }

  getCurrentLogTokens(): number {
    return this.logTokens;
  }

  configure(opts: { reasoningEffort?: "high" | "max"; model?: string }): void {
    if (opts.model) this.model = opts.model;
    void this.daemon
      .configure(this.sessionId, opts)
      .then(() => this.refresh())
      .catch(() => undefined);
  }

  setBudget(usd: number | null): void {
    this.budgetUsd = typeof usd === "number" && usd > 0 ? usd : null;
    void this.daemon.setBudget(this.sessionId, usd).catch(() => undefined);
  }

  /** Remote retry is best-effort, not synchronous — degraded to no-op (the rich UI's retry button). */
  retryLastUser(): string | null {
    return null;
  }

  async compactHistory(): Promise<{ removed: number }> {
    await this.daemon.compact(this.sessionId);
    await this.refresh();
    return { removed: 0 };
  }

  private async refresh(): Promise<void> {
    try {
      const s = await this.daemon.stats(this.sessionId);
      this.budgetUsd = s.budgetUsd;
      this.logTokens = s.logTokens;
      (this.prefix as { system: string }).system = s.prefixSystem;
      (this.prefix as { toolSpecs: unknown }).toolSpecs = safeParse(s.prefixToolSpecs);
    } catch {
      // keep the last snapshot on a transient stats failure
    }
  }
}

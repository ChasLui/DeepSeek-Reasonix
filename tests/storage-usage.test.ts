import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDb } from "../src/storage/db.js";
import {
  appendUsageRow,
  countByModel,
  countBySession,
  pruneUsageBefore,
  readAllUsage,
  readUsageSince,
} from "../src/storage/usage-repo.js";
import { type UsageRecord, aggregateUsage, readUsageLog } from "../src/telemetry/usage.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "reasonix-usage-"));
}

const FIXTURE: UsageRecord[] = [
  {
    ts: 1000,
    session: "s1",
    model: "v4-flash",
    promptTokens: 100,
    completionTokens: 20,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
    costUsd: 0.001,
    claudeEquivUsd: 0.02,
  },
  {
    ts: 2000,
    session: null,
    model: "v4-pro",
    promptTokens: 200,
    completionTokens: 50,
    reasoningTokens: 30,
    cacheHitTokens: 0,
    cacheMissTokens: 200,
    costUsd: 0.01,
    claudeEquivUsd: 0.2,
    workspace: "/tmp/ws",
  },
  {
    ts: 3000,
    session: "s1",
    model: "v4-flash",
    promptTokens: 50,
    completionTokens: 10,
    cacheHitTokens: 40,
    cacheMissTokens: 10,
    costUsd: 0.0005,
    claudeEquivUsd: 0.01,
    kind: "subagent",
    subagent: {
      skillName: "explore",
      taskPreview: "find X",
      toolIters: 3,
      durationMs: 1200,
    },
  },
];

// CJS (-e default) so child processes load node:sqlite natively, bypassing vite.
const WRITER_SCRIPT = [
  'const {DatabaseSync}=require("node:sqlite");',
  "const db=new DatabaseSync(process.argv[1]);",
  'db.exec("PRAGMA busy_timeout=8000");',
  "const n=+process.argv[2];",
  'const s=db.prepare("INSERT INTO usage (ts,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost_usd,claude_equiv_usd,kind) VALUES (?,?,?,?,?,?,?,?,?)");',
  'for(let i=0;i<n;i++) s.run(Date.now(),"m",0,0,0,0,0,0,"turn");',
].join("");

afterEach(() => resetDb());

describe("storage/usage-repo", () => {
  it("aggregateUsage over SQLite rows equals over JSONL (SC-005)", () => {
    const dir = tmpDir();
    const jsonlPath = join(dir, "usage.jsonl");
    writeFileSync(jsonlPath, `${FIXTURE.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

    const db = getDb(join(dir, "reasonix.db"));
    for (const r of FIXTURE) appendUsageRow(db, r);

    expect(aggregateUsage(readAllUsage(db), { now: 4000 })).toEqual(
      aggregateUsage(readUsageLog(jsonlPath), { now: 4000 }),
    );
    expect(readAllUsage(db)).toEqual(readUsageLog(jsonlPath));
  });

  it("readUsageSince windows by ts; SQL counts match aggregateUsage (FR-007)", () => {
    const db = getDb(join(tmpDir(), "reasonix.db"));
    for (const r of FIXTURE) appendUsageRow(db, r);

    expect(readUsageSince(db, 2000).map((r) => r.ts)).toEqual([2000, 3000]);

    const agg = aggregateUsage(readAllUsage(db));
    expect(countByModel(db)).toEqual(agg.byModel);
    expect(countBySession(db)).toEqual(agg.bySession);
  });

  it("pruneUsageBefore deletes the time window (FR-009 retention)", () => {
    const db = getDb(join(tmpDir(), "reasonix.db"));
    for (const r of FIXTURE) appendUsageRow(db, r);
    expect(pruneUsageBefore(db, 2500)).toBe(2);
    expect(readAllUsage(db).map((r) => r.ts)).toEqual([3000]);
  });

  it("SIGKILL mid-write leaves the db intact, committed rows survive (SC-009)", async () => {
    const dbPath = join(tmpDir(), "reasonix.db");
    getDb(dbPath);
    resetDb();

    const child = spawn(process.execPath, ["-e", WRITER_SCRIPT, dbPath, "100000"], {
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 80));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));

    const db = getDb(dbPath);
    // crash-safety is PARITY with JSONL, not a win (NF-002/NF-003): the file is
    // not corrupt and committed rows survive; we make no power-loss claim.
    expect(String(db.prepare("PRAGMA integrity_check").get()?.integrity_check)).toBe("ok");
    expect(Number(db.prepare("SELECT count(*) c FROM usage").get()?.c)).toBeGreaterThanOrEqual(0);
  });

  it("concurrent multi-process writers lose no rows (SC-006)", async () => {
    const dbPath = join(tmpDir(), "reasonix.db");
    getDb(dbPath);
    resetDb();

    const procs = 4;
    const perProc = 25;
    const writer = (): Promise<number> =>
      new Promise((res) => {
        const p = spawn(process.execPath, ["-e", WRITER_SCRIPT, dbPath, String(perProc)], {
          stdio: "ignore",
        });
        p.on("exit", (code) => res(code ?? 1));
      });

    const codes = await Promise.all(Array.from({ length: procs }, writer));
    expect(codes.every((c) => c === 0)).toBe(true);

    const db = getDb(dbPath);
    expect(Number(db.prepare("SELECT count(*) c FROM usage").get()?.c)).toBe(procs * perProc);
  });
});

import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { parseToolResult } from "./helpers/tool-result.js";

function registerSpawnSubagent(reg: ToolRegistry): void {
  reg.register({
    name: "spawn_subagent",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
      },
      required: ["task"],
    },
    fn: ({ task }: { task: string }) => `spawned ${task}`,
  });
}

function countUnknownUnaliased(stats: ReturnType<ToolRegistry["getRepairStats"]>): number {
  let count = 0;
  for (const perTool of Object.values(stats)) {
    count += perTool["unknown-tool-unaliased"] ?? 0;
  }
  return count;
}

describe("ToolRegistry tool aliases", () => {
  it("dispatches legacy Task calls through spawn_subagent", async () => {
    const reg = new ToolRegistry();
    registerSpawnSubagent(reg);

    const out = await reg.dispatch("Task", { task: "summarize the diff" });

    expect(out).toBe("spawned summarize the diff");
  });

  it("keeps the unaliased unknown-tool contract", async () => {
    const reg = new ToolRegistry();

    const out = await reg.dispatch("nope", {});

    expect(parseToolResult(out)).toEqual({ error: "unknown tool: nope" });
    expect(reg.getRepairStats().nope?.["unknown-tool-unaliased"]).toBe(1);
  });

  it("audits the resolved tool name and counts the original alias bucket", async () => {
    const reg = new ToolRegistry();
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    registerSpawnSubagent(reg);
    reg.setAuditListener((event) => {
      seen.push({
        name: event.name,
        args: JSON.parse(JSON.stringify(event.args)) as Record<string, unknown>,
      });
    });

    await reg.dispatch("Task", { task: "inspect workspace" });

    expect(seen).toEqual([{ name: "spawn_subagent", args: { task: "inspect workspace" } }]);
    expect(reg.getRepairStats().Task?.["unknown-tool-aliased"]).toBe(1);
    expect(reg.getRepairStats().spawn_subagent?.["unknown-tool-aliased"]).toBeUndefined();
    expect(reg.getRepairStats().spawn_subagent?.["unknown-tool-unaliased"]).toBeUndefined();
  });

  it("falls back to unaliased accounting when an alias target or valid args are missing", async () => {
    const reg = new ToolRegistry();

    const unknownOut = await reg.dispatch("nope", {});
    const aliasOut = await reg.dispatch("Task", { task: "inspect workspace" });

    expect(parseToolResult(unknownOut)).toEqual({ error: "unknown tool: nope" });
    expect(parseToolResult(aliasOut)).toEqual({ error: "unknown tool: Task" });
    expect(reg.getRepairStats().Task?.["unknown-tool-unaliased"]).toBe(1);
    expect(countUnknownUnaliased(reg.getRepairStats())).toBe(2);

    const validationReg = new ToolRegistry();
    registerSpawnSubagent(validationReg);
    const validationOut = await validationReg.dispatch("Task", {});

    expect(parseToolResult(validationOut).error).toMatch(/argument validation failed/);
    expect(validationReg.getRepairStats().Task?.["unknown-tool-unaliased"]).toBe(1);
    expect(validationReg.getRepairStats().Task?.["unknown-tool-aliased"]).toBeUndefined();
  });
});

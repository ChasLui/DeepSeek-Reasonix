/** Golden: the daemon's background code-graph path (loadCodeGraph → incrementalUpdate) produces the same graph as a from-scratch lazy full rebuild (NF-105). Compares node + edge SETS, excluding non-deterministic artifact metadata (mtimeMs / graphHash / elapsedMs live in file stamps + artifact headers, never in nodes/edges). */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodeGraph, incrementalUpdate } from "../src/index/code-graph/builder.js";
import { loadCodeGraph } from "../src/index/code-graph/loader.js";
import type { InMemoryCodeGraph } from "../src/index/code-graph/types.js";

/** Deterministic comparison surface: sorted qualified node names ∪ sorted edges (by node id). */
function shape(g: InMemoryCodeGraph): { nodes: string[]; edges: string[] } {
  return {
    nodes: [...g.nodes].map((n) => n.qualifiedName).sort(),
    edges: [...g.edges].map((e) => `${e.source}->${e.target}`).sort(),
  };
}

describe("daemon background indexing — incremental ≡ full (NF-105 golden)", () => {
  it("code-graph incremental update equals a from-scratch full rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-eqv-"));
    writeFileSync(join(root, "a.ts"), "export function foo() {\n  return 1;\n}\n");
    writeFileSync(
      join(root, "b.ts"),
      'import { foo } from "./a.js";\nexport function bar() {\n  return foo();\n}\n',
    );

    // initial full build → artifact on disk
    await buildCodeGraph(root, { timeoutMs: 60_000 });

    // a change lands: b.ts gains a symbol
    writeFileSync(
      join(root, "b.ts"),
      'import { foo } from "./a.js";\nexport function bar() {\n  return foo();\n}\nexport function baz() {\n  return 2;\n}\n',
    );

    // background path: load the prior graph + incrementalUpdate(stale) → writes the incremental artifact
    const loaded = await loadCodeGraph(root);
    if (!loaded) throw new Error("expected an initial graph");
    await incrementalUpdate(root, loaded, ["b.ts"], { timeoutMs: 60_000 });
    const inc = await loadCodeGraph(root);
    if (!inc) throw new Error("expected an incremental graph");
    const shapeInc = shape(inc);

    // lazy path: full rebuild from scratch over the same on-disk files (overwrites the artifact)
    await buildCodeGraph(root, { timeoutMs: 60_000 });
    const full = await loadCodeGraph(root);
    if (!full) throw new Error("expected a full graph");
    const shapeFull = shape(full);

    expect(shapeInc).toEqual(shapeFull);
    // sanity: the added symbol is actually present (guard against an empty==empty pass)
    expect(shapeInc.nodes.some((n) => n.includes("baz"))).toBe(true);
  });
});

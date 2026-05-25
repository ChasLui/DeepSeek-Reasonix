import { resolve } from "node:path";
import { loadCodeGraphEnabled } from "../../config.js";
import { buildCodeGraph } from "../../index/code-graph/builder.js";

export interface RebuildCodeGraphOptions {
  dir?: string;
  json?: boolean;
}

export async function rebuildCodeGraphCommand(opts: RebuildCodeGraphOptions = {}): Promise<void> {
  if (!loadCodeGraphEnabled()) {
    const reason = codeGraphDisabledReason();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ disabled: true, reason })}\n`);
      return;
    }
    process.stderr.write(`code-graph disabled: ${reason}\n`);
    return;
  }
  const result = await buildCodeGraph(resolve(opts.dir ?? process.cwd()));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stderr.write(
    `code-graph rebuilt: files=${result.filesScanned} nodes=${result.nodes} edges=${result.edges} unresolved=${result.unresolvedRefs} elapsed=${result.elapsedMs}ms\n`,
  );
}

function codeGraphDisabledReason(): string {
  const env = process.env.REASONIX_CODE_GRAPH?.trim();
  return env ? `REASONIX_CODE_GRAPH=${env}` : "config.codeGraph";
}

import type { ToolSpec } from "../types.js";
import { sha256Prefix } from "../utils/sha256.js";

export interface ToolSchemaDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export class ToolSchemaIndex {
  index(toolSpecs: readonly ToolSpec[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const spec of toolSpecs) {
      const fn = spec.function;
      out.set(
        fn.name,
        sha256Prefix(
          JSON.stringify({
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          }),
        ),
      );
    }
    return out;
  }

  diff(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): ToolSchemaDiff {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const name of next.keys()) {
      if (!prev.has(name)) {
        added.push(name);
        continue;
      }
      if (prev.get(name) !== next.get(name)) changed.push(name);
    }
    for (const name of prev.keys()) {
      if (!next.has(name)) removed.push(name);
    }

    return {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    };
  }
}

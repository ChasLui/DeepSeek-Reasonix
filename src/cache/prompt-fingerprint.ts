import type { ImmutablePrefix } from "../memory/runtime.js";
import { sha256Prefix } from "../utils/sha256.js";
import { ToolSchemaIndex } from "./tool-schema.js";

export interface PromptSnapshot {
  systemHash: string;
  toolsHash: string;
  perToolHashes: ReadonlyMap<string, string>;
  systemCharCount: number;
  toolCount: number;
  capturedAt: number;
}

export interface PendingPromptChanges {
  systemChanged: boolean;
  toolsChanged: boolean;
  changedToolNames: string[];
  addedToolNames: string[];
  removedToolNames: string[];
  systemCharDelta: number;
}

export class PromptFingerprint {
  constructor(private readonly toolSchemaIndex = new ToolSchemaIndex()) {}

  snapshot(prefix: ImmutablePrefix): PromptSnapshot {
    const tools = prefix.tools();
    const perToolHashes = this.toolSchemaIndex.index(tools);
    return {
      systemHash: sha256Prefix(prefix.system),
      toolsHash: sha256Prefix(JSON.stringify(tools)),
      perToolHashes: new Map(perToolHashes),
      systemCharCount: prefix.system.length,
      toolCount: tools.length,
      capturedAt: Date.now(),
    };
  }

  diff(prev: PromptSnapshot | null, next: PromptSnapshot): PendingPromptChanges {
    if (prev === null) {
      return {
        systemChanged: false,
        toolsChanged: false,
        changedToolNames: [],
        addedToolNames: [],
        removedToolNames: [],
        systemCharDelta: 0,
      };
    }
    const toolDiff = this.toolSchemaIndex.diff(prev.perToolHashes, next.perToolHashes);
    const toolsChanged =
      prev.toolsHash !== next.toolsHash ||
      toolDiff.added.length > 0 ||
      toolDiff.removed.length > 0 ||
      toolDiff.changed.length > 0;
    return {
      systemChanged: prev.systemHash !== next.systemHash,
      toolsChanged,
      changedToolNames: toolDiff.changed,
      addedToolNames: toolDiff.added,
      removedToolNames: toolDiff.removed,
      systemCharDelta: next.systemCharCount - prev.systemCharCount,
    };
  }
}

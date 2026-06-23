import { useState, useCallback } from "preact/hooks";
import { api } from "./api.js";

export interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  patch?: string;
  status: "added" | "deleted" | "modified";
}

export interface ReviewDiffsState {
  diffs: FileDiff[];
  loading: boolean;
  modifiedFiles: () => Set<string>;
  modifiedCount: () => number;
  reload: (ep?: string) => Promise<void>;
}

export function useReviewDiffs(): ReviewDiffsState {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDiffs = useCallback(async (ep: string = "/review-diffs") => {
    setLoading(true);
    try {
      const data = await api<FileDiff[]>(ep);
      setDiffs(Array.isArray(data) ? data : []);
    } catch {
      setDiffs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const modifiedFiles = useCallback(() => new Set(diffs.map((d) => d.file)), [diffs]);
  const modifiedCount = useCallback(() => diffs.length, [diffs]);

  return {
    diffs: diffs,
    loading: loading,
    modifiedFiles: modifiedFiles,
    modifiedCount: modifiedCount,
    reload: loadDiffs,
  };
}

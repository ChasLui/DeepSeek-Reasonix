export interface CodeRelationStats {
  queries: number;
  candidatesScanned: number;
  changedFiles: number;
  relations: number;
  fallbacks: number;
  savedRoundsEstimate: number;
}

const stats: CodeRelationStats = {
  queries: 0,
  candidatesScanned: 0,
  changedFiles: 0,
  relations: 0,
  fallbacks: 0,
  savedRoundsEstimate: 0,
};

export function resetCodeRelationStats(): void {
  stats.queries = 0;
  stats.candidatesScanned = 0;
  stats.changedFiles = 0;
  stats.relations = 0;
  stats.fallbacks = 0;
  stats.savedRoundsEstimate = 0;
}

export function getCodeRelationStats(): CodeRelationStats {
  return { ...stats };
}

export function recordCodeRelationQuery(input: {
  candidatesScanned?: number;
  changedFiles?: number;
  relations?: number;
  fallback?: boolean;
  savedRoundsEstimate?: number;
}): void {
  stats.queries += 1;
  stats.candidatesScanned += input.candidatesScanned ?? 0;
  stats.changedFiles += input.changedFiles ?? 0;
  stats.relations += input.relations ?? 0;
  if (input.fallback) stats.fallbacks += 1;
  stats.savedRoundsEstimate += input.savedRoundsEstimate ?? 0;
}

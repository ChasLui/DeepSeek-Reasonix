export interface RankedHit {
  docId: string;
  score: number;
}

export function fuseRrf(rankings: readonly (readonly RankedHit[])[], k = 60): RankedHit[] {
  if (rankings.length === 0) return [];
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let ordinal = 0;

  for (const ranking of rankings) {
    const seenInRanking = new Set<string>();
    for (let i = 0; i < ranking.length; i++) {
      const hit = ranking[i];
      if (!hit || seenInRanking.has(hit.docId)) continue;
      seenInRanking.add(hit.docId);
      if (!firstSeen.has(hit.docId)) firstSeen.set(hit.docId, ordinal++);
      scores.set(hit.docId, (scores.get(hit.docId) ?? 0) + 1 / (k + i + 1));
    }
  }

  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (firstSeen.get(a.docId) ?? Number.MAX_SAFE_INTEGER) -
          (firstSeen.get(b.docId) ?? Number.MAX_SAFE_INTEGER) ||
        a.docId.localeCompare(b.docId),
    );
}

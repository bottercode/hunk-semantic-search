/**
 * Scores stored vectors against a query vector and keeps the best matches.
 *
 * Pure and order-stable: ties keep their input order, which is review order, so equal scores
 * list hunks the way the review stream shows them.
 */

export interface Scored<T> {
  item: T;
  score: number;
}

/** Cosine similarity of two vectors; 0 when either is all zeros or the lengths differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** Return the `k` items most similar to `query`, best first. */
export function topK<T>(query: ArrayLike<number>, items: readonly T[], vectorOf: (item: T) => ArrayLike<number>, k: number) {
  const scored: Scored<T>[] = items.map((item) => ({ item, score: cosine(query, vectorOf(item)) }));
  // Array.prototype.sort is stable, so equal scores keep review order.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}

/**
 * Result collapse and diversity control helpers (issue #45).
 * Deduplicates / caps multiple chunks per document or canonical identity
 * to increase result diversity in search output.
 */

export function collapseResults<T>(
  results: T[],
  getDocId: (hit: T) => string,
  maxPerDoc: number = 1
): T[] {
  if (!maxPerDoc || maxPerDoc <= 0) return results;
  const counts = new Map<string, number>();
  const collapsed: T[] = [];

  for (const hit of results) {
    const docId = getDocId(hit);
    const count = counts.get(docId) || 0;
    if (count < maxPerDoc) {
      counts.set(docId, count + 1);
      collapsed.push(hit);
    }
  }

  return collapsed;
}

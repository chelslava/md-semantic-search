// @ts-check
/**
 * Result collapse and diversity control helpers (issue #45).
 * Deduplicates / caps multiple chunks per document or canonical identity
 * to increase result diversity in search output.
 */

/**
 * Collapse candidate hits so no single file/canonical document exceeds maxPerFile/maxPerDoc.
 * @template T
 * @param {T[]} results
 * @param {(hit: T) => string} getDocId
 * @param {number} [maxPerDoc=1]
 * @returns {T[]}
 */
export function collapseResults(results, getDocId, maxPerDoc = 1) {
  if (!maxPerDoc || maxPerDoc <= 0) return results;
  const counts = new Map();
  const collapsed = [];

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

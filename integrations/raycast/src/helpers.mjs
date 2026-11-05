/**
 * Pure helpers for the Raycast "Search Notes" command (issue #230) —
 * unit-tested in test/raycast.test.mjs. The React component only wires
 * these to @raycast/api.
 */

/** Search request body for POST /search. */
export function buildSearchRequest(query, { k = 12 } = {}) {
  return { query: String(query || '').trim(), k };
}

/**
 * Parse the daemon /search response. Accepts both the modern {results:[...]}
 * envelope and the legacy bare array (same contract as the shared client).
 */
export function parseSearchResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

/** Debounce delay for the live search input (ms). */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Search hit → props for a Raycast List.Item (title/subtitle/accessories/
 * detail markdown + actions payload), shared by the command's render path.
 */
export function toListItem(hit) {
  const score = typeof hit?.cosine === 'number' ? hit.cosine : (hit?.score ?? 0);
  const heading = hit?.heading || hit?.file || '';
  const title = hit?.title || hit?.file || 'Untitled';
  return {
    key: `${hit?.file}-${hit?.heading}`,
    title,
    subtitle: heading,
    accessory: `cos: ${Number(score).toFixed(3)}`,
    markdown:
      `# ${title}\n\n**File**: \`${hit?.file}\`` +
      `${hit?.heading ? ` › **${hit.heading}**` : ''}\n\n---\n\n${hit?.snippet || ''}`,
    openTarget: hit?.file,
    snippet: hit?.snippet || '',
  };
}

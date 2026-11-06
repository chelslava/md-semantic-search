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

/**
 * issue #250: launcher parity — filter preferences map into the /search body
 * the same way the web UI's filter inputs do. Empty values are omitted so a
 * user configuring only `tag` does not send empty type/status fields.
 */
export function buildSearchRequestWithFilters(query, { k = 12, tag, type, status } = {}) {
  const body = buildSearchRequest(query, { k });
  if (tag && String(tag).trim()) body.tag = String(tag).trim();
  if (type && String(type).trim()) body.type = String(type).trim();
  if (status && String(status).trim()) body.status = String(status).trim();
  return body;
}

/**
 * issue #250: request body for the streamed POST /ask (Raycast ask-notes).
 * No chat sessions from a launcher — one-shot asks keep the model simple.
 */
export function buildAskRequest(query, { k = 6 } = {}) {
  return { query: String(query || '').trim(), k };
}

/**
 * issue #250: accumulated SSE frames → the ask Detail view's markdown
 * (answer + the sources list the `sources` frame delivered). Pure so tests
 * can pin the shape; the command streams deltas through this as they land.
 */
export function renderAskDetail({ answer, sources, mode }) {
  const parts = [];
  if (answer && answer.trim()) parts.push(answer);
  if (sources && sources.length) {
    parts.push(
      '---\n\n**Sources**\n\n' +
        sources.map((s) => `- \`${s.file}${s.heading ? ` › ${s.heading}` : ''}\``).join('\n'),
    );
  }
  if (mode) parts.push(`\n\n_answer mode: ${mode}_`);
  return parts.join('\n\n');
}

/**
 * Shared MDSS daemon client used by the editor integrations (issue #112).
 *
 * Single source of truth for the HTTP contract of `mdss serve`:
 *   POST /search  {query, k}            -> {results: [...]}   (envelope!)
 *   GET  /health                        -> {ok, chunks, model, ...}
 *
 * History note (issue #112): integrations/vscode historically parsed the
 * /search response as a BARE results array, which never matched the server
 * envelope. The client below accepts both shapes so old/new daemons work,
 * and tests pin the canonical envelope.
 */

/** Fields every search hit is expected to carry per the current mdss API. */
export const SEARCH_HIT_FIELDS = [
  'file', 'title', 'heading', 'cosine', 'score', 'snippet',
  'startLine', 'endLine',
];

export function createSearchClient({ baseUrl = 'http://127.0.0.1:8747', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('search-client: no fetch implementation available');
  }

  async function post(path, body) {
    const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Daemon returned HTTP ${resp.status}`);
    return resp.json();
  }

  /**
   * Semantic search. Resolves to an ARRAY of hits regardless of whether the
   * daemon used the modern {results:[...]} envelope or a legacy bare array.
   */
  async function search(query, { k = 10 } = {}) {
    const data = await post('/search', { query, k });
    if (Array.isArray(data)) return data;              // legacy shape
    if (Array.isArray(data?.results)) return data.results;
    throw new Error('Unexpected /search response shape');
  }

  /** Health probe; returns the parsed body or throws on non-2xx. */
  async function health() {
    const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`);
    if (!resp.ok) throw new Error(`Daemon returned HTTP ${resp.status}`);
    return resp.json();
  }

  return { search, health };
}

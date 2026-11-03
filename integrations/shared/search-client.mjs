/**
 * Shared MDSS daemon client used by the editor integrations (issue #112).
 *
 * Single source of truth for the HTTP contract of `mdss serve`:
 *   POST /search  {query, k}            -> {results: [...]}   (envelope!)
 *   GET  /health                        -> {ok, chunks, model, ...}
 *   POST /ask     {query, k, sessionId?}-> SSE: session?/sources/delta/done
 *                                         (issue #199; needs --llm-endpoint)
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

/**
 * Splits raw SSE text into complete `event:`/`data:` frames (issue #199).
 * Incremental: pass the accumulated buffer, get finished frames plus the
 * remainder to keep for the next chunk. CRLF frames and stray CR are
 * normalized; a frame without a data line (e.g. a bare comment keep-alive)
 * is dropped.
 */
export function extractSseFrames(buffer) {
  const frames = [];
  let rest = String(buffer == null ? '' : buffer).replace(/\r\n?/g, '\n');
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.lastIndexOf('event:', 0) === 0) event = line.slice(6).trim();
      else if (line.lastIndexOf('data:', 0) === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join('\n') });
  }
  return { frames, rest };
}

export function createSearchClient({
  baseUrl = 'http://127.0.0.1:8747',
  apiKey = undefined,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('search-client: no fetch implementation available');
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function post(path, body) {
    const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: headers(),
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

  /**
   * Streamed grounded QA over POST /ask (issue #199). `onFrame(event, obj)`
   * fires per SSE frame (session/sources/delta/done/error) as it arrives;
   * the promise resolves with the `done` payload once the stream ends.
   * The daemon must run with --llm-endpoint, otherwise it answers 400.
   */
  async function ask(query, {
    k = 5,
    sessionId = undefined,
    chat = false,
    onFrame = () => {},
    signal = undefined,
  } = {}) {
    const body = { query, k };
    const sid = String(sessionId == null ? '' : sessionId).trim();
    if (sid) body.sessionId = sid;
    else if (chat) body.chat = true;

    const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/ask`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!resp.ok) {
      let detail = `Daemon returned HTTP ${resp.status}`;
      try {
        const j = await resp.json();
        if (j?.error) detail = j.error;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }

    let buffer = '';
    let done = null;
    const consume = (event, data) => {
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      if (event === 'done') done = obj;
      onFrame(event, obj);
    };
    const reader = resp.body?.getReader?.();
    if (!reader) throw new Error('Daemon response has no readable stream (streaming unsupported)');
    const dec = new TextDecoder();
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += dec.decode(value, { stream: true });
      const parsed = extractSseFrames(buffer);
      buffer = parsed.rest;
      for (const f of parsed.frames) consume(f.event, f.data);
    }
    // flush a trailing frame that ended without its blank line
    const tail = extractSseFrames(`${buffer}\n\n`);
    for (const f of tail.frames) consume(f.event, f.data);
    return done;
  }

  /** Health probe; returns the parsed body or throws on non-2xx. */
  async function health() {
    const resp = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`);
    if (!resp.ok) throw new Error(`Daemon returned HTTP ${resp.status}`);
    return resp.json();
  }

  return { search, health, ask };
}

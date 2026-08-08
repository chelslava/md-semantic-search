// @ts-check
/**
 * Long-running daemon mode (issue #12): keeps the parsed index AND the
 * embedding extractor in memory across queries, so repeated searches skip
 * the ~280 MB model load and the full vectors.json parse on every call.
 *
 *   mdss serve --db ./docs [--port 8747] [--host 127.0.0.1] [--watch]
 *
 * HTTP API (no auth — binds to loopback 127.0.0.1 by default; use --host to
 * opt into LAN exposure, issue #16):
 *   POST /search  {"query": "...", "k": 6, "semanticOnly": false} → {results: [...]}
 *   GET  /health  → {ok, chunks, model, dim, built, watching}
 *   GET  /        → endpoint list
 *
 * --watch polls the markdown base for mtime changes (no new deps) and runs the
 * incremental re-index (chunk-level cache) when something changed.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.mjs';
import { loadIndex, searchIndex } from './search.mjs';
import { walkMarkdown } from './core.mjs';

const DEFAULT_PORT = 8747;
const DEFAULT_HOST = '127.0.0.1';     // loopback by default — LAN exposure is opt-in via --host
const WATCH_INTERVAL_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;     // POST /search body cap (DoS guard, issue #16)

/**
 * @typedef {Object} ServeState
 * @property {ReturnType<typeof loadIndex>} loaded - parsed index + resolved model
 * @property {string} indexDir
 * @property {string} cacheDir
 * @property {boolean} offline
 * @property {Function} embedFn
 * @property {Function} [rerankFn] - rerank override (tests)
 * @property {boolean} watching
 * @property {Map<string, number>} [lastMtimes]
 */

/**
 * Create the HTTP server (not yet listening). The index is built if missing,
 * then loaded once into memory; every /search reuses it (issue #2).
 * @param {object} opts
 * @param {string} opts.indexDir
 * @param {string} opts.cacheDir
 * @param {string} [opts.db] - markdown base; required for --watch / auto-build
 * @param {string} [opts.modelName='e5-base']
 * @param {string[]} [opts.ignore=[]]
 * @param {boolean} [opts.offline=false]
 * @param {boolean} [opts.watch=false]
 * @param {number} [opts.watchInterval=WATCH_INTERVAL_MS]
 * @param {Function} [opts.embedFn] - embed override (tests)
 * @param {Function} [opts.rerankFn] - rerank override (tests)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{server: import('node:http').Server, state: ServeState, close: ()=>Promise<void>}>}
 */
export async function createServe(opts) {
  const {
    indexDir, cacheDir, db, modelName = 'e5-base', ignore = [],
    offline = false, watch = false, watchInterval = WATCH_INTERVAL_MS,
    embedFn, rerankFn, log = () => {},
  } = opts;

  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(path.join(indexDir, 'vectors.json'))) {
    if (!db) throw new Error('serve: no index found and no --db given to build one');
    log(`No index at ${indexDir} — building it from ${db}…`);
    await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
  }

  /** @type {ServeState} */
  const state = {
    loaded: loadIndex(indexDir),
    indexDir, cacheDir, offline, embedFn, rerankFn, watching: watch,
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch(e => {
      json(res, 500, { error: e.message });
    });
  });

  let stopped = false;
  let timer = null;

  const reload = async () => {
    if (!db) return;
    log('Change detected — re-indexing…');
    await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
    state.loaded = loadIndex(indexDir);
    log(`Re-indexed; ${state.loaded.index.chunks.length} chunks in memory.`);
  };

  const scanMtimes = () => {
    if (!db) return new Map();
    const mtimes = new Map();
    for (const f of walkMarkdown(db, ignore)) {
      try { mtimes.set(f, fs.statSync(f).mtimeMs); } catch { /* file vanished mid-scan */ }
    }
    return mtimes;
  };

  const watchLoop = async () => {
    state.lastMtimes = scanMtimes();
    while (!stopped) {
      await new Promise(r => { timer = setTimeout(r, watchInterval); });
      if (stopped) return;
      const cur = scanMtimes();
      const prev = state.lastMtimes;
      let changed = cur.size !== prev.size;
      if (!changed) {
        for (const [f, m] of cur) {
          if (prev.get(f) !== m) { changed = true; break; }
        }
      }
      if (changed) {
        await reload().catch(e => log(`re-index failed: ${e.message}`));
        state.lastMtimes = scanMtimes();
      }
    }
  };

  if (watch) {
    if (!db) throw new Error('serve --watch requires --db');
    watchLoop();
  }

  const close = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve())));
  };

  return { server, state, close };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ServeState} state
 */
async function handleRequest(req, res, state) {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/search') {
    // DoS guard (issue #16): honor a declared Content-Length, cap the streamed
    // body at MAX_BODY_BYTES with 413, and never buffer unbounded input.
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isInteger(n) || n < 0 || n > MAX_BODY_BYTES) {
        json(res, 413, { error: `payload too large (limit ${MAX_BODY_BYTES} bytes)` });
        return;
      }
    }
    let body = '';
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { tooLarge = true; break; }
    }
    if (tooLarge) {
      json(res, 413, { error: `payload too large (limit ${MAX_BODY_BYTES} bytes)` });
      req.resume(); // drain the rest so the connection is not left half-open
      return;
    }
    /** @type {{query?:string, k?:number, semanticOnly?:boolean, rerank?:boolean}} */
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; }
    catch (e) {
      json(res, 400, { error: `invalid JSON body: ${e.message}` });
      return;
    }
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query) { json(res, 400, { error: 'missing "query" string in JSON body' }); return; }
    const k = Number.isInteger(payload.k) && payload.k > 0 ? payload.k : 6;

    try {
      const results = await searchIndex({
        loaded: state.loaded,
        cacheDir: state.cacheDir,
        query,
        k,
        semanticOnly: !!payload.semanticOnly,
        rerank: !!payload.rerank,
        offline: state.offline,
        embedFn: state.embedFn,
        rerankFn: state.rerankFn,
      });
      json(res, 200, { query, k, count: results.length, results });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      chunks: state.loaded.index.chunks.length,
      model: state.loaded.model.id,
      dim: state.loaded.index.dim || state.loaded.model.dim || 0,
      built: state.loaded.index.built || null,
      watching: state.watching,
      indexDir: state.indexDir,
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
    json(res, 200, {
      name: 'mdss serve',
      endpoints: [
        { method: 'POST', path: '/search', body: '{ "query": "...", "k": 6, "semanticOnly": false, "rerank": false }' },
        { method: 'GET', path: '/health' },
      ],
    });
    return;
  }

  json(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {object} data */
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export { DEFAULT_PORT, DEFAULT_HOST, MAX_BODY_BYTES, WATCH_INTERVAL_MS };

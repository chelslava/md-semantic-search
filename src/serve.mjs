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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.mjs';
import { loadIndex, searchIndex } from './search.mjs';
import { walkMarkdown } from './core.mjs';

const DEFAULT_PORT = 8747;
const DEFAULT_HOST = '127.0.0.1';     // loopback by default — LAN exposure is opt-in via --host
const WATCH_INTERVAL_MS = 3000;
const WATCH_DELAY_MS = 1000;          // quiet-period debounce before a change fires a re-index (issue #42)
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
 * @property {number} [reindexCount] - watch loop: how many re-indexes fired (tests)
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
 * @param {number} [opts.watchDelay=WATCH_DELAY_MS] - quiet-period debounce (issue #42)
 * @param {Function} [opts.embedFn] - embed override (tests)
 * @param {Function} [opts.rerankFn] - rerank override (tests)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{server: import('node:http').Server, state: ServeState, close: ()=>Promise<void>}>}
 */
export async function createServe(opts) {
  const {
    indexDir, cacheDir, db, modelName = 'e5-base', ignore = [],
    offline = false, watch = false, watchInterval = WATCH_INTERVAL_MS,
    watchDelay = WATCH_DELAY_MS,
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
    state.reindexCount = (state.reindexCount ?? 0) + 1;
    log(`Re-indexed; ${state.loaded.index.chunks.length} chunks in memory.`);
  };

  // --- watch scanning (issue #42) ---
  // Detection is anchored to the CONTENT the indexer last wrote, never to the
  // poll-to-poll mtime delta. The authoritative per-file md5 lives in
  // `.hashes.json` (keys are POSIX-relative paths, values are md5 of the file
  // bytes as read by buildIndex). We compare the live tree against THAT
  // baseline, so three subclasses are handled uniformly:
  //   (a) no-op writes (touch/chmod, an editor rewriting identical bytes) —
  //       mtime moved but md5 still equals the indexed hash → filtered out;
  //   (b) coarse-mtime filesystems (FAT, older SMB) where two real edits share
  //       one mtime window — mtime is a *hint to skip hashing*, never proof of
  //       "unchanged"; the md5 compare still catches the edit;
  //   (c) new / deleted files — a rel path absent from / present-only-in the
  //       indexed set.
  // A settle debounce (`watchDelay`, default 1s) then collapses a burst of
  // successive saves (editor save → linter → save) into ONE re-index: we only
  // reload once the tree's fingerprint has been stable for the quiet period.
  const fileMd5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const relOf = (f) => path.relative(db, f).split(path.sep).join('/');

  /**
   * Content fingerprint of the live tree: sorted `rel:md5` pairs. Two polls that
   * see the same tree content produce the same fingerprint — this is the settle
   * signal. Each file resolves through `hashAt`, so an unchanged (path, mtime)
   * is served from the cache and only a file whose mtime moved pays a re-hash.
   */
  const treeContentFingerprint = (tree) => {
    const parts = [];
    for (const [f, { m, rel }] of tree) {
      let md5;
      try { md5 = hashAt(f, m); } catch { md5 = 'unreadable'; }
      parts.push(`${rel}:${md5}`);
    }
    return parts.sort().join('|');
  };

  /** rel path → md5 of the content the indexer last persisted ({} when unreadable). */
  const readIndexedHashes = () => {
    try { return JSON.parse(fs.readFileSync(path.join(indexDir, '.hashes.json'), 'utf8')); }
    catch { return {}; }
  };

  /** Live tree snapshot: abs path → { m, rel }. Files that vanish mid-scan are skipped. */
  const scanTree = () => {
    const tree = new Map();
    if (!db) return tree;
    for (const f of walkMarkdown(db, ignore)) {
      try { tree.set(f, { m: fs.statSync(f).mtimeMs, rel: relOf(f) }); }
      catch { /* file vanished mid-scan */ }
    }
    return tree;
  };

  // md5s are cached per (path, mtime) so steady-state polls stay cheap; the
  // cache is only a memo of "hash of the content at that mtime" and is never
  // trusted across an mtime bump.
  const md5Cache = new Map();   // abs path → { mtime, md5 }
  const hashAt = (f, m) => {
    const hit = md5Cache.get(f);
    if (hit && hit.mtime === m) return hit.md5;
    const md5 = fileMd5(f);
    md5Cache.set(f, { mtime: m, md5 });
    return md5;
  };

  /**
   * rel paths whose CONTENT differs from the INDEXED baseline. mtime is only a
   * pre-filter to skip hashing a file that is unchanged AND already confirmed:
   * the hash cache tells us "content at this mtime", the index tells us "content
   * that is indexed". A file is reported changed iff its *current* content hash
   * differs from the hash the indexer last persisted.
   */
  const contentChangedPaths = (tree, indexedHashes) => {
    const out = [];
    const liveRels = new Set();
    for (const [f, { m, rel }] of tree) {
      liveRels.add(rel);
      if (!(rel in indexedHashes)) { out.push(rel); continue; }       // new file
      const cached = md5Cache.get(f);
      // Fast path: we have already hashed THIS (path, mtime) and it matches the index.
      if (cached && cached.mtime === m && cached.md5 === indexedHashes[rel]) continue;
      let fresh;
      try { fresh = hashAt(f, m); } catch { continue; }               // unreadable mid-write → next poll
      if (fresh !== indexedHashes[rel]) out.push(rel);                // real content change
      // no-op write (mtime moved, content identical to the index): fall through,
      // the cache now confirms content-at-this-mtime matches the baseline, so the
      // NEXT poll with the same mtime takes the fast path and stays quiet.
    }
    for (const rel of Object.keys(indexedHashes)) {
      if (!liveRels.has(rel)) out.push(rel);                          // deleted file
    }
    return out;
  };

  const watchLoop = async () => {
    // The baseline is what the INDEX contains, not what the last poll saw.
    let indexedHashes = readIndexedHashes();
    // Pre-seed the md5 cache from the indexed baseline so steady-state polls
    // hash nothing: a file whose mtime is unchanged since the index was built
    // is by definition still at its indexed content (buildIndex read exactly
    // that). Only used as a memo; any mtime move re-hashes for real.
    for (const [f, { m, rel }] of scanTree()) {
      if (rel in indexedHashes) md5Cache.set(f, { mtime: m, md5: indexedHashes[rel] });
    }

    let lastFingerprint = treeContentFingerprint(scanTree()); // content baseline
    let lastChangeAt = 0;   // timestamp of the most recent content movement
    let pending = false;    // tree differs from the index AND has stopped moving
    while (!stopped) {
      await new Promise(r => { timer = setTimeout(r, watchInterval); });
      if (stopped) return;
      const tree = scanTree();
      const fingerprint = treeContentFingerprint(tree);
      const changed = contentChangedPaths(tree, indexedHashes);
      if (fingerprint !== lastFingerprint) {
        // Content moved since the last poll: a save (or several) is in flight.
        // (Re)start the quiet window; do NOT reload yet — the burst may not be
        // done (editor save → linter → save). A no-op touch does NOT move the
        // fingerprint, so it can't even enter here.
        if (!pending) log(`watch: change in ${changed.length} file(s) — waiting ${watchDelay} ms for the tree to settle…`);
        pending = true;
        lastFingerprint = fingerprint;
        lastChangeAt = Date.now();
      } else if (pending && changed.length > 0 && Date.now() - lastChangeAt >= watchDelay) {
        // Tree content stable for the whole quiet window AND still differs from
        // the index → the burst settled on real new content. Re-index ONCE.
        pending = false;
        await reload().catch(e => log(`re-index failed: ${e.message}`));
        indexedHashes = readIndexedHashes();
        for (const [f, { m, rel }] of scanTree()) {
          if (rel in indexedHashes) md5Cache.set(f, { mtime: m, md5: indexedHashes[rel] });
        }
        lastFingerprint = treeContentFingerprint(scanTree());
      } else if (pending && changed.length === 0) {
        // Fingerprint stable AND content already equals the index — happens when
        // a no-op write raced us into pending. Nothing to do; drop the pend.
        pending = false;
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

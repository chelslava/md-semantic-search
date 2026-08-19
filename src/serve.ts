/**
 * Long-running daemon mode (issue #12): keeps the parsed index AND the
 * embedding extractor in memory across queries, so repeated searches skip
 * the ~280 MB model load and the full vectors.json parse on every call.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.js';
import { loadIndex, searchIndex } from './search.js';
import { walkMarkdown, assertSafePath, ModelDescriptor } from './core.js';
import { createFileWatcher, FileWatcher } from './watcher.js';

const DEFAULT_PORT = 8747;
const DEFAULT_HOST = '127.0.0.1';
const WATCH_INTERVAL_MS = 3000;
const WATCH_DELAY_MS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ServeState {
  loaded: { index: any; model: ModelDescriptor };
  indexDir: string;
  cacheDir: string;
  offline: boolean;
  embedFn?: any;
  rerankFn?: any;
  watching: boolean;
  reindexCount?: number;
  apiKey?: string;
  healthPublic?: boolean;
}

export interface CreateServeOptions {
  indexDir: string;
  cacheDir: string;
  db?: string;
  modelName?: string;
  ignore?: string[];
  offline?: boolean;
  watch?: boolean;
  watchInterval?: number;
  watchDelay?: number;
  apiKey?: string;
  healthPublic?: boolean;
  embedFn?: any;
  rerankFn?: any;
  log?: (msg: string) => void;
}

export async function createServe(opts: CreateServeOptions): Promise<{
  server: http.Server;
  state: ServeState;
  close: () => Promise<void>;
}> {
  const {
    indexDir,
    cacheDir,
    db,
    modelName = 'e5-base',
    ignore = [],
    offline = false,
    watch = false,
    watchInterval = WATCH_INTERVAL_MS,
    watchDelay = WATCH_DELAY_MS,
    apiKey = process.env.MDSS_API_KEY,
    healthPublic = process.env.MDSS_HEALTH_PUBLIC === 'true',
    embedFn,
    rerankFn,
    log = () => {},
  } = opts;

  if (indexDir) assertSafePath(indexDir);
  if (db) assertSafePath(db);

  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(path.join(indexDir, 'vectors.json'))) {
    if (!db) throw new Error('serve: no index found and no --db given to build one');
    log(`No index at ${indexDir} — building it from ${db}…`);
    await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
  }

  const state: ServeState = {
    loaded: loadIndex(indexDir),
    indexDir,
    cacheDir,
    offline,
    embedFn,
    rerankFn,
    watching: watch,
    apiKey,
    healthPublic,
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch((e) => {
      json(res, 500, { error: e.message });
    });
  });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const reload = async () => {
    if (!db) return false;
    log('Change detected — re-indexing…');
    try {
      await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
    } catch (e: any) {
      if (/(being written by pid|being written|lock)/i.test(String(e?.message || ''))) {
        log(`re-index deferred: ${e.message}`);
        return false;
      }
      throw e;
    }
    state.loaded = loadIndex(indexDir);
    state.reindexCount = (state.reindexCount ?? 0) + 1;
    log(`Re-indexed; ${state.loaded.index.chunks.length} chunks in memory.`);
    return true;
  };

  const fileMd5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const relOf = (f: string) => path.relative(db!, f).split(path.sep).join('/');

  const md5Cache = new Map<string, { mtime: number; md5: string }>();
  const hashAt = (f: string, m: number) => {
    const hit = md5Cache.get(f);
    if (hit && hit.mtime === m) return hit.md5;
    const md5 = fileMd5(f);
    md5Cache.set(f, { mtime: m, md5 });
    return md5;
  };

  const treeContentFingerprint = (tree: Map<string, { m: number; rel: string }>) => {
    const parts: string[] = [];
    for (const [f, { m, rel }] of tree) {
      let md5: string;
      try {
        md5 = hashAt(f, m);
      } catch {
        md5 = 'unreadable';
      }
      parts.push(`${rel}:${md5}`);
    }
    return parts.sort().join('|');
  };

  const readIndexedHashes = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(indexDir, '.hashes.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  const scanTree = (): Map<string, { m: number; rel: string }> => {
    const tree = new Map<string, { m: number; rel: string }>();
    if (!db) return tree;
    for (const f of walkMarkdown(db, ignore)) {
      try {
        tree.set(f, { m: fs.statSync(f).mtimeMs, rel: relOf(f) });
      } catch {
        /* vanished */
      }
    }
    return tree;
  };

  const contentChangedPaths = (tree: Map<string, { m: number; rel: string }>, indexedHashes: Record<string, string>) => {
    const out: string[] = [];
    const liveRels = new Set<string>();
    for (const [f, { m, rel }] of tree) {
      liveRels.add(rel);
      if (!(rel in indexedHashes)) {
        out.push(rel);
        continue;
      }
      const cached = md5Cache.get(f);
      if (cached && cached.mtime === m && cached.md5 === indexedHashes[rel]) continue;
      let fresh: string;
      try {
        fresh = hashAt(f, m);
      } catch {
        continue;
      }
      if (fresh !== indexedHashes[rel]) out.push(rel);
    }
    for (const rel of Object.keys(indexedHashes)) {
      if (!liveRels.has(rel)) out.push(rel);
    }
    return out;
  };

  let lastFingerprint = '';

  const watchLoop = async () => {
    let indexedHashes = readIndexedHashes();
    lastFingerprint = treeContentFingerprint(scanTree());
    let lastChangeAt = 0;
    let pending = false;
    while (!stopped) {
      await new Promise((r) => {
        timer = setTimeout(r, watchInterval);
      });
      if (stopped) return;
      const tree = scanTree();
      const fingerprint = treeContentFingerprint(tree);
      const changed = contentChangedPaths(tree, indexedHashes);
      if (fingerprint !== lastFingerprint) {
        if (!pending) log(`watch: change in ${changed.length} file(s) — waiting ${watchDelay} ms for the tree to settle…`);
        pending = true;
        lastFingerprint = fingerprint;
        lastChangeAt = Date.now();
      } else if (pending && changed.length > 0 && Date.now() - lastChangeAt >= watchDelay) {
        pending = false;
        await reload().catch((e) => log(`re-index failed: ${e.message}`));
        indexedHashes = readIndexedHashes();
        for (const [f, { m, rel }] of scanTree()) {
          if (!md5Cache.has(f) && rel in indexedHashes) {
            md5Cache.set(f, { mtime: m, md5: indexedHashes[rel] });
          }
        }
        lastFingerprint = treeContentFingerprint(scanTree());
      } else if (!pending && changed.length > 0 && fingerprint === lastFingerprint) {
        pending = true;
        lastChangeAt = Date.now();
        log(`watch: tree differs from index (no motion) — settling then re-index…`);
      } else if (pending && changed.length === 0 && Date.now() - lastChangeAt < watchDelay) {
        pending = false;
      }
    }
  };

  let nativeWatcher: FileWatcher | null = null;

  if (watch) {
    if (!db) throw new Error('serve --watch requires --db');
    nativeWatcher = createFileWatcher(db, () => {
      // Prompt watchLoop settle trigger on native event
      lastFingerprint = '';
    }, {
      debounceMs: watchDelay,
      ignore,
      log,
    });
    watchLoop();
  }

  const close = async (): Promise<void> => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (nativeWatcher) nativeWatcher.close();
    // closeAllConnections() forcibly closes keep-alive sockets so server.close()
    // doesn't hang indefinitely waiting for them — critical on Node 18 where the
    // HTTP server does NOT auto-drain idle connections before calling back.
    // The method was back-ported to Node 18.2.0 and is always present in CI.
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  };

  return { server, state, close };
}

export function isAuthorizedToken(token?: string | null, expectedKey?: string | null): boolean {
  if (!token || typeof token !== 'string') return false;
  if (!expectedKey || typeof expectedKey !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, state: ServeState): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');

  if (state.apiKey) {
    const isPublicHealth = url.pathname === '/health' && req.method === 'GET' && state.healthPublic;
    if (!isPublicHealth) {
      const authHeader = req.headers['authorization'];
      const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
      const token = match ? match[1].trim() : null;
      if (!token || !isAuthorizedToken(token, state.apiKey)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }
  }

  if (req.method === 'POST' && url.pathname === '/search') {
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
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      json(res, 413, { error: `payload too large (limit ${MAX_BODY_BYTES} bytes)` });
      req.resume();
      return;
    }
    let payload: Record<string, any>;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch (e: any) {
      json(res, 400, { error: `invalid JSON body: ${e.message}` });
      return;
    }
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query) {
      json(res, 400, { error: 'missing "query" string in JSON body' });
      return;
    }
    if (query.length > 2048) {
      json(res, 400, { error: 'query exceeds maximum length of 2048 characters' });
      return;
    }
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
        tag: payload.tag,
        project: payload.project,
        type: payload.type,
        status: payload.status,
        canonicalOnly: payload.canonicalOnly,
        custom: payload.custom,
        explain: !!payload.explain,
        maxPerFile: payload.maxPerFile || payload.maxPerDoc,
        ann: payload.ann,
        nprobe: payload.nprobe,
        graphBoost: payload.graphBoost,
        filter: payload.filter,
      });
      json(res, 200, { query, k, count: results.length, results });
    } catch (e: any) {
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

function json(res: http.ServerResponse, status: number, data: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export { DEFAULT_PORT, DEFAULT_HOST, MAX_BODY_BYTES, WATCH_INTERVAL_MS };

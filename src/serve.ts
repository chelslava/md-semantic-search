/**
 * Long-running daemon mode (issue #12): keeps the parsed index AND the
 * embedding extractor in memory across queries, so repeated searches skip
 * the ~280 MB model load and the full vectors.json parse on every call.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from './indexer.js';
import { loadIndex, searchIndex } from './search.js';
import { walkMarkdown, assertSafePath, getDocLines, ModelDescriptor } from './core.js';
import { createFileWatcher, FileWatcher, classifyFsError, readWithRetry } from './watcher.js';
import { WEBUI_HTML, WEBUI_JS, WEBUI_CSS } from './webui.js';
import { handleMcpRequest } from './mcp.js';
import { findRelatedNotes } from './wikilinks.js';

const DEFAULT_PORT = 8747;
const DEFAULT_HOST = '127.0.0.1';
const WATCH_INTERVAL_MS = 3000;
const WATCH_DELAY_MS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

/** Hosts a browser is allowed to name in the Host header (issue #120). */
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Fairness defaults (issue #119): protective yet friction-free locally. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const DEFAULT_RATE_BURST = 10;
export const DEFAULT_MAX_CONCURRENCY = os.cpus().length || 1;

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
  /** issue #111: serve the built-in web UI at `/` (default on). */
  ui?: boolean;
  /** issue #123: mount the Streamable HTTP MCP transport at /mcp (default off). */
  mcp?: boolean;
  mcpSessionId?: string;
  /** Extra Host-header values accepted beyond the loopback defaults (issue #120). */
  allowedHosts?: string[];
  /** Exact origins reflected as `Access-Control-Allow-Origin`; absent → CORS off (issue #120). */
  corsOrigins?: string[];
  /** Fairness gates for /search (issue #119); `0` disables a gate. */
  limiter?: ServeLimiter;
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
  allowedHosts?: string[];
  corsOrigins?: string[];
  rateLimit?: number;
  maxConcurrency?: number;
  /** issue #116: verbose watch-loop trace (polls, retries, classifications). */
  watchDebug?: boolean;
  /** issue #116 test seam: override hashing/stat so fault-injection needs no real locks. */
  _testFs?: {
    hash?: (absPath: string) => string;
    stat?: (absPath: string) => { mtimeMs: number };
  };
  ui?: boolean;
  /** issue #123: mount Streamable HTTP MCP at /mcp (default off; stdio stays default). */
  mcp?: boolean;
  embedFn?: any;
  rerankFn?: any;
  log?: (msg: string) => void;
}

/**
 * Token bucket for per-client request budgeting (issue #119): starts full
 * (`burst`), refills continuously at `limitPerMinute`/60 tokens per second.
 * `take` is injective in time so tests can time-travel via the `now` argument.
 */
export class TokenBucket {
  private tokens: number;
  /** Last refill timestamp — doubles as a staleness marker for map pruning. */
  lastTouched: number;

  constructor(readonly limitPerMinute: number, readonly burst: number) {
    this.tokens = burst;
    this.lastTouched = Date.now();
  }

  take(now: number = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    const elapsedMs = Math.max(0, now - this.lastTouched);
    this.lastTouched = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs * this.limitPerMinute) / 60_000);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const retryAfterSec = Math.max(1, Math.ceil(((1 - this.tokens) * 60_000) / this.limitPerMinute / 1000));
    return { ok: false, retryAfterSec };
  }
}

/** A granted slot's release handle — idempotent, so `finally` is always safe. */
type SlotRelease = () => void;

/**
 * Counting semaphore with a bounded wait queue (issue #119): once `maxQueued`
 * callers already wait, acquire() returns null instead of enqueueing, so an
 * overloaded daemon sheds load with 503 rather than ballooning memory.
 */
export class BoundedSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly size: number, readonly maxQueued: number) {
    this.available = size;
  }

  get executing(): number {
    return this.size - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<SlotRelease | null> {
    if (this.available > 0) {
      this.available -= 1;
      return makeRelease(() => this.releaseSlot());
    }
    if (this.waiters.length >= this.maxQueued) return null;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return makeRelease(() => this.releaseSlot());
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot straight to a waiter — count stays consistent
    else this.available += 1;
  }
}

function makeRelease(release: () => void): SlotRelease {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      release();
    }
  };
}

/**
 * Fairness gates for POST /search (issue #119):
 *  - per-client token bucket → 429 + Retry-After when a client exceeds its budget;
 *  - global concurrency cap around the embedding sweep; queue overflow → 503.
 * Either gate disabled by passing `0`; counters are exposed via /health.
 */
export class ServeLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly sem: BoundedSemaphore | null;
  rejected429 = 0;
  rejected503 = 0;

  constructor(
    readonly rateLimitPerMin: number,
    readonly rateBurst: number,
    readonly maxConcurrency: number,
  ) {
    // queue depth cap: 2× slots (min 4) — enough burst absorption, bounded memory
    this.sem = maxConcurrency > 0 ? new BoundedSemaphore(maxConcurrency, Math.max(maxConcurrency * 2, 4)) : null;
  }

  /** Burst is capped by the per-minute budget itself (--rate-limit 5 → burst 5). */
  private effectiveBurst(): number {
    return Math.min(this.rateBurst, Math.max(1, this.rateLimitPerMin));
  }

  get rateEnabled(): boolean {
    return this.rateLimitPerMin > 0 && this.rateBurst > 0;
  }

  get concurrencyEnabled(): boolean {
    return this.sem !== null;
  }

  get inFlight(): number {
    return this.sem ? this.sem.executing : 0;
  }

  get queued(): number {
    return this.sem ? this.sem.queued : 0;
  }

  get rejectedTotal(): number {
    return this.rejected429 + this.rejected503;
  }

  /** Cheap synchronous rate check. Null → proceed; otherwise reject with 429. */
  gate(clientKey: string, now: number = Date.now()): { status: 429; retryAfterSec: number } | null {
    if (!this.rateEnabled) return null;
    let bucket = this.buckets.get(clientKey);
    if (!bucket) {
      if (this.buckets.size >= 4096) {
        // opportunistic prune of idle clients (no takes within two windows)
        for (const [key, b] of this.buckets) {
          if (now - b.lastTouched > 2 * 60_000) this.buckets.delete(key);
        }
      }
      bucket = new TokenBucket(this.rateLimitPerMin, this.effectiveBurst());
      this.buckets.set(clientKey, bucket);
    }
    const r = bucket.take(now);
    if (r.ok) return null;
    this.rejected429 += 1;
    return { status: 429, retryAfterSec: r.retryAfterSec };
  }

  /**
   * Acquire a global search slot. Resolves with a release handle, or null when
   * the wait queue is saturated (caller replies 503).
   */
  async acquireSlot(): Promise<SlotRelease | null> {
    if (!this.sem) return makeRelease(() => {});
    const release = await this.sem.acquire();
    if (!release) this.rejected503 += 1;
    return release;
  }
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
    allowedHosts,
    corsOrigins,
    rateLimit = DEFAULT_RATE_LIMIT_PER_MIN,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    watchDebug = false,
    _testFs,
    mcp = false,
    ui = true,
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
    ui: ui !== false,
    mcp,
    allowedHosts,
    corsOrigins,
    limiter: new ServeLimiter(rateLimit, DEFAULT_RATE_BURST, maxConcurrency),
  };

  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch((e) => {
      json(res, 500, { error: e.message });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveTimer: (() => void) | null = null;

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

  const fileMd5 = (f: string): string =>
    _testFs?.hash ? _testFs.hash(f) : crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const statFile = (f: string): { mtimeMs: number } =>
    _testFs?.stat ? _testFs.stat(f) : { mtimeMs: fs.statSync(f).mtimeMs };
  const relOf = (f: string) => path.relative(db!, f).split(path.sep).join('/');
  const dbg = (msg: string) => {
    if (watchDebug) log(`watch-debug: ${msg}`);
  };

  const md5Cache = new Map<string, { mtime: number; md5: string }>();
  // issue #116: files whose hash currently fails (AV/sync contention) — they
  // are EXCLUDED from fingerprints instead of becoming stable 'unreadable'
  // ones, so a transiently locked file can never mask a real change.
  const unreadable = new Map<string, { cls: 'transient' | 'permanent'; code: string; firstAt: number }>();
  let lastWarnAt = 0;
  const WARN_COOLDOWN_MS = 30_000;

  /**
   * Hash a file with bounded retry for TRANSIENT failures (issue #116).
   * Returns null when the file must be excluded this cycle: vanished (deleted),
   * or still unreadable after retries (changed-pending, warned rate-limited).
   */
  const hashWithRetry = async (f: string, m: number): Promise<string | null> => {
    const hit = md5Cache.get(f);
    if (hit && hit.mtime === m) {
      unreadable.delete(f);
      return hit.md5;
    }
    const r = await readWithRetry(() => fileMd5(f), {
      attempts: 3,
      baseDelayMs: 200,
      onRetry: (attempt, err) => dbg(`retry ${attempt} ${path.basename(f)}: ${(err as any)?.code ?? (err as any)?.message}`),
    });
    if (r.ok) {
      md5Cache.set(f, { mtime: m, md5: r.value });
      unreadable.delete(f);
      dbg(`hashed ${path.basename(f)}`);
      return r.value;
    }
    const cls = classifyFsError(r.err);
    if (cls === 'vanished') {
      md5Cache.delete(f);
      return null; // deleted mid-cycle — handled via liveRels diff
    }
    const prev = unreadable.get(f);
    unreadable.set(f, {
      cls: cls as 'transient' | 'permanent',
      code: (r.err as any)?.code || String((r.err as any)?.message || 'error'),
      firstAt: prev?.firstAt ?? Date.now(),
    });
    return null;
  };

  /**
   * One probe pass: hash every tree file (with retry). Returns per-file hashes
   * where null = vanished-or-unreadable this cycle (excluded from comparison).
   */
  const probeTree = async (tree: Map<string, { m: number; rel: string }>) => {
    const hashes = new Map<string, string | null>();
    for (const [f, { m }] of tree) {
      hashes.set(f, await hashWithRetry(f, m));
    }
    return hashes;
  };

  const fingerprintOf = (
    tree: Map<string, { m: number; rel: string }>,
    fileHashes: Map<string, string | null>,
  ): string => {
    const parts: string[] = [];
    for (const [f, { rel }] of tree) {
      const h = fileHashes.get(f);
      if (h !== null && h !== undefined) parts.push(`${rel}:${h}`);
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

  /** issue #116: stat failures are classified — only ENOENT vanishes silently. */
  const scanTree = (): { tree: Map<string, { m: number; rel: string }>; problems: Map<string, 'transient' | 'permanent'> } => {
    const tree = new Map<string, { m: number; rel: string }>();
    const problems = new Map<string, 'transient' | 'permanent'>();
    if (!db) return { tree, problems };
    for (const f of walkMarkdown(db, ignore)) {
      try {
        tree.set(f, { m: statFile(f).mtimeMs, rel: relOf(f) });
      } catch (e) {
        const cls = classifyFsError(e);
        if (cls !== 'vanished') problems.set(f, cls as 'transient' | 'permanent');
        /* vanished files drop out via the liveRels diff */
      }
    }
    return { tree, problems };
  };

  const contentChangedPaths = (
    tree: Map<string, { m: number; rel: string }>,
    fileHashes: Map<string, string | null>,
    indexedHashes: Record<string, string>,
  ) => {
    const out: string[] = [];
    const liveRels = new Set<string>();
    for (const [f, { rel }] of tree) {
      liveRels.add(rel);
      if (!(rel in indexedHashes)) {
        out.push(rel); // new file
        continue;
      }
      const fresh = fileHashes.get(f);
      if (fresh === null || fresh === undefined) continue; // unreadable → changed-pending
      if (fresh !== indexedHashes[rel]) out.push(rel);
    }
    for (const rel of Object.keys(indexedHashes)) {
      if (!liveRels.has(rel)) out.push(rel);
    }
    return out;
  };

  let lastFingerprint = '';

  /** issue #116: one combined warning per cooldown, ≤5 files named + "+k more". */
  const warnUnreadableRateLimited = (now: number): void => {
    if (unreadable.size === 0 || now - lastWarnAt < WARN_COOLDOWN_MS) return;
    lastWarnAt = now;
    const names = [...unreadable.keys()].map((f) => path.basename(f));
    const head = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? ` …+${names.length - 5} more` : '';
    const codes = [...new Set([...unreadable.values()].map((u) => u.code))].join('/');
    log(`watch: ${unreadable.size} file(s) unreadable (${codes}) — will retry: ${head}${more}`);
  };

  const watchLoop = async () => {
    let indexedHashes = readIndexedHashes();
    {
      const { tree } = scanTree();
      const hashes = await probeTree(tree);
      lastFingerprint = fingerprintOf(tree, hashes);
    }
    let lastChangeAt = 0;
    let pending = false;
    while (!stopped) {
      await new Promise<void>((r) => {
        resolveTimer = r;
        timer = setTimeout(() => {
          timer = null;
          resolveTimer = null;
          r();
        }, watchInterval);
        timer.unref?.();
      });
      if (stopped) return;
      const t0 = Date.now();
      const { tree, problems } = scanTree();
      for (const [f, cls] of problems) {
        if (!unreadable.has(f)) unreadable.set(f, { cls, code: `stat:${cls}`, firstAt: t0 });
      }
      dbg(`poll: ${tree.size} file(s), ${unreadable.size} pending-unreadable`);
      const fileHashes = await probeTree(tree);
      warnUnreadableRateLimited(Date.now());
      const fingerprint = fingerprintOf(tree, fileHashes);
      const changed = contentChangedPaths(tree, fileHashes, indexedHashes);
      if (fingerprint !== lastFingerprint) {
        if (!pending) log(`watch: change in ${changed.length} file(s) — waiting ${watchDelay} ms for the tree to settle…`);
        pending = true;
        lastFingerprint = fingerprint;
        lastChangeAt = Date.now();
      } else if (pending && changed.length > 0 && Date.now() - lastChangeAt >= watchDelay) {
        pending = false;
        await reload().catch((e) => log(`re-index failed: ${e.message}`));
        indexedHashes = readIndexedHashes();
        {
          const fresh = scanTree();
          const freshHashes = await probeTree(fresh.tree);
          // seed the md5 cache from the authoritative post-build state so the
          // next fingerprint is IO-free for unchanged files
          for (const [f, { m, rel }] of fresh.tree) {
            const h = freshHashes.get(f);
            if (h !== null && h !== undefined && !md5Cache.has(f)) md5Cache.set(f, { mtime: m, md5: h });
          }
          lastFingerprint = fingerprintOf(fresh.tree, freshHashes);
        }
      } else if (!pending && changed.length > 0 && fingerprint === lastFingerprint) {
        pending = true;
        lastChangeAt = Date.now();
        log(`watch: tree differs from index (no motion) — settling then re-index…`);
      } else if (pending && changed.length === 0 && Date.now() - lastChangeAt < watchDelay) {
        pending = false;
      } else if (pending && changed.length === 0) {
        // settled but nothing actually differs (e.g. a locked file became
        // readable again with unchanged content) — resync the baseline
        pending = false;
        lastFingerprint = fingerprint;
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
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (resolveTimer) {
      resolveTimer();
      resolveTimer = null;
    }
    if (nativeWatcher) nativeWatcher.close();
    server.closeAllConnections?.();
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }
    sockets.clear();
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

/** True when `host` binds to loopback only (issue #121). Empty/undefined means the loopback default. */
export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return true;
  const h = String(host).trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '::ffff:127.0.0.1' ||
    h === '[::ffff:127.0.0.1]'
  );
}

/**
 * Refuse to start an unauthenticated server on a non-loopback interface (issue #121):
 * `mdss serve --host 0.0.0.0` without an API key silently serves the whole knowledge
 * base to the LAN. Explicit `--allow-unsecured` opts in (banner still printed by CLI).
 */
export function validateBindSecurity(opts: { host?: string; hasApiKey: boolean; allowUnsecured?: boolean }): void {
  const { host, hasApiKey, allowUnsecured } = opts;
  if (hasApiKey || allowUnsecured || isLoopbackHost(host)) return;
  throw new Error(
    `serve: refusing to bind non-loopback host "${host}" without authentication.\n` +
    '  This would expose the entire knowledge base to the network.\n' +
    '  Fix one of:\n' +
    '    --api-key <key>            require Bearer auth on every request\n' +
    '    --api-key-file <path>      read the key from a file (or MDSS_API_KEY_FILE)\n' +
    '    --allow-unsecured          explicit opt-in (e.g. behind a firewall/reverse proxy)'
  );
}

/**
 * Read an API key from a file (issue #121): avoids shell-history / CI-log leaks of
 * literal `--api-key` values. Trailing newlines are trimmed; on POSIX a group- or
 * world-readable key file draws a loud warning.
 */
export function loadApiKeyFile(filePath: string, log?: (msg: string) => void): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e: any) {
    throw new Error(`api-key-file: cannot read ${filePath}: ${e.message}`);
  }
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(filePath).mode & 0o777;
      if (mode & 0o077) {
        log?.(`api-key-file: WARNING ${filePath} is readable by group/others (mode ${mode.toString(8)}) — chmod 600 recommended`);
      }
    } catch {
      /* stat raced after a successful read — not fatal */
    }
  }
  const key = raw.replace(/[\r\n]+$/, '');
  if (!key) throw new Error(`api-key-file: ${filePath} contains no key`);
  return key;
}

/**
 * Strip the port from a Host header value, keeping IPv6 bracket forms intact:
 * "localhost:8747" → "localhost", "[::1]:8747" → "[::1]", "::1" → "::1" (issue #120).
 */
export function splitHostHeader(hostHeader: string): string {
  const s = String(hostHeader).trim().toLowerCase();
  const m = s.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (m) return m[1];
  const first = s.indexOf(':');
  const last = s.lastIndexOf(':');
  // a single colon separates host:port; several colons mean a bare IPv6 literal
  return first !== -1 && first === last ? s.slice(0, first) : s;
}

/**
 * Reflect CORS headers ONLY for an exact allowlisted Origin (issue #120).
 * Off entirely by default; `Vary: Origin` is set whenever CORS is configured so
 * shared caches never hand a cross-origin response to another origin.
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse, origins?: string[]): void {
  if (!origins || origins.length === 0) return;
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, state: ServeState): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');

  // DNS-rebinding protection (issue #120): after a rebind attack the browser's
  // Host header names the attacker's domain instead of ours — reject it with 403
  // BEFORE anything else so a rebound page is never treated as same-origin.
  const hostHeader = req.headers.host;
  const hostName = typeof hostHeader === 'string' ? splitHostHeader(hostHeader) : '';
  const allowedHosts = new Set<string>([
    ...DEFAULT_ALLOWED_HOSTS,
    ...(state.allowedHosts || []).map(splitHostHeader),
  ]);
  if (!hostName || !allowedHosts.has(hostName)) {
    json(res, 403, { error: `untrusted Host header${hostHeader ? ` "${hostHeader}"` : ' (missing)'}` });
    return;
  }

  applyCors(req, res, state.corsOrigins);

  // CORS preflight — only meaningful when --cors-origin is configured.
  if (req.method === 'OPTIONS') {
    if (state.corsOrigins && state.corsOrigins.length > 0) {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600',
      });
      res.end();
    } else {
      json(res, 405, { error: 'method not allowed' });
    }
    return;
  }

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

  // Streamable HTTP MCP transport (issue #123): same auth/host/rate-limit
  // gates as /search, reusing handleMcpRequest untouched as the tool brain.
  if (state.mcp && url.pathname === '/mcp') {
    await handleMcpHttp(req, res, state);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/search') {
    // Fairness gate 1 (issue #119): per-client token bucket → 429 + Retry-After.
    const limited = state.limiter?.gate(req.socket.remoteAddress || 'unknown');
    if (limited) {
      res.setHeader('retry-after', String(limited.retryAfterSec));
      json(res, 429, { error: 'rate limit exceeded — slow down', retryAfterSec: limited.retryAfterSec });
      return;
    }

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

    // Fairness gate 2 (issue #119): one global slot around the model sweep;
    // a saturated wait queue sheds load with 503 instead of ballooning.
    const release = state.limiter ? await state.limiter.acquireSlot() : null;
    if (!release) {
      res.setHeader('retry-after', '1');
      json(res, 503, { error: 'server busy — search concurrency cap reached, queue full' });
      return;
    }
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
        recency: typeof payload.recency === 'number' && payload.recency > 0 ? payload.recency : undefined,
      });
      json(res, 200, { query, k, count: results.length, results });
    } catch (e: any) {
      json(res, 500, { error: e.message });
    } finally {
      release();
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/doc') {
    const file = url.searchParams.get('file');
    if (!file) {
      json(res, 400, { error: 'missing "file" query parameter' });
      return;
    }
    const fromLineParam = url.searchParams.get('fromLine') || url.searchParams.get('from');
    const maxLinesParam = url.searchParams.get('maxLines') || url.searchParams.get('lines') || url.searchParams.get('limit');
    const fromLine = fromLineParam ? parseInt(fromLineParam, 10) : 1;
    const maxLines = maxLinesParam ? parseInt(maxLinesParam, 10) : undefined;

    try {
      const docResult = getDocLines({
        file,
        fromLine: isNaN(fromLine) ? 1 : fromLine,
        maxLines: maxLines && !isNaN(maxLines) ? maxLines : undefined,
        dbDir: state.loaded.index.db,
        chunks: state.loaded.index.chunks,
      });
      json(res, 200, docResult);
    } catch (e: any) {
      if (e.message?.includes('not found')) {
        json(res, 404, { error: e.message });
      } else {
        json(res, 400, { error: e.message });
      }
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
      // fairness counters (issue #119)
      in_flight: state.limiter?.inFlight ?? 0,
      queued: state.limiter?.queued ?? 0,
      rejected_total: state.limiter?.rejectedTotal ?? 0,
      rate_limit_per_min: state.limiter?.rateEnabled ? state.limiter.rateLimitPerMin : null,
      max_concurrency: state.limiter?.concurrencyEnabled ? state.limiter.maxConcurrency : null,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/' && state.ui) {
    // Built-in web UI (issue #111): strict CSP, split assets, no inline code.
    sendAsset(res, 'text/html; charset=utf-8', WEBUI_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ui.js' && state.ui) {
    sendAsset(res, 'text/javascript; charset=utf-8', WEBUI_JS);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ui.css' && state.ui) {
    sendAsset(res, 'text/css; charset=utf-8', WEBUI_CSS);
    return;
  }

  if (url.pathname === '/related' && (req.method === 'POST' || req.method === 'GET')) {
    let target = '';
    let k = 10;
    let direction: 'both' | 'outgoing' | 'backlinks' = 'both';
    let semantic = true;

    if (req.method === 'GET') {
      target = url.searchParams.get('file') || url.searchParams.get('target') || url.searchParams.get('note') || '';
      const kParam = url.searchParams.get('k');
      if (kParam) k = parseInt(kParam, 10) || 10;
      const dirParam = url.searchParams.get('direction');
      if (dirParam === 'outgoing' || dirParam === 'backlinks' || dirParam === 'both') direction = dirParam;
      if (url.searchParams.has('semantic')) semantic = url.searchParams.get('semantic') !== 'false';
    } else {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) break;
      }
      try {
        const payload = body ? JSON.parse(body) : {};
        target = payload.file || payload.target || payload.note || '';
        if (typeof payload.k === 'number' && payload.k > 0) k = payload.k;
        if (payload.direction === 'outgoing' || payload.direction === 'backlinks' || payload.direction === 'both') {
          direction = payload.direction;
        }
        if (payload.semantic !== undefined) semantic = Boolean(payload.semantic);
      } catch (e: any) {
        json(res, 400, { error: `invalid JSON body: ${e.message}` });
        return;
      }
    }

    if (!target) {
      json(res, 400, { error: 'missing "file" or "target" parameter' });
      return;
    }

    try {
      const relatedResult = findRelatedNotes({
        loaded: state.loaded,
        target,
        k,
        direction,
        semantic,
      });
      json(res, 200, relatedResult);
    } catch (e: any) {
      if (e.message?.includes('not found')) {
        json(res, 404, { error: e.message });
      } else {
        json(res, 400, { error: e.message });
      }
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
    json(res, 200, {
      name: 'mdss serve',
      endpoints: [
        { method: 'POST', path: '/search', body: '{ "query": "...", "k": 6, "semanticOnly": false, "rerank": false }' },
        { method: 'GET', path: '/doc?file=...&fromLine=1&maxLines=50' },
        { method: 'POST', path: '/related', body: '{ "file": "...", "k": 10, "semantic": true }' },
        { method: 'GET', path: '/health' },
      ],
    });
    return;
  }

  json(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
}

/**
 * Streamable HTTP transport for MCP (issue #123): POST carries JSON-RPC
 * (single message or batch), notifications answer 202, GET opens the SSE
 * server-channel, DELETE terminates a session. Responses are plain JSON —
 * the spec allows JSON instead of SSE when nothing is streamed. Session id is
 * minted on first contact and echoed back on every reply.
 */
async function handleMcpHttp(req: http.IncomingMessage, res: http.ServerResponse, state: ServeState): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    // Server-initiated channel: we have nothing to push today, so keep the
    // stream alive with comments until the client goes away.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
    });
    res.write(':ok\n\n');
    const hb = setInterval(() => {
      try {
        res.write(':hb\n\n');
      } catch {
        /* closed */
      }
    }, 15_000);
    hb.unref?.();
    req.on('close', () => clearInterval(hb));
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // Same fairness gate as /search — tools/call can trigger embedding work.
  const limited = state.limiter?.gate(req.socket.remoteAddress || 'unknown');
  if (limited) {
    res.setHeader('retry-after', String(limited.retryAfterSec));
    json(res, 429, { error: 'rate limit exceeded - slow down', retryAfterSec: limited.retryAfterSec });
    return;
  }
  const release = state.limiter ? await state.limiter.acquireSlot() : null;
  if (!release) {
    res.setHeader('retry-after', '1');
    json(res, 503, { error: 'server busy' });
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        json(res, 413, { error: `payload too large (limit ${MAX_BODY_BYTES} bytes)` });
        return;
      }
    }
    let messages: any;
    try {
      messages = JSON.parse(body || '{}');
    } catch (e: any) {
      json(res, 400, { error: `invalid JSON: ${e.message}` });
      return;
    }
    const batch = Array.isArray(messages);
    const items = batch ? messages : [messages];

    const responses: any[] = [];
    for (const msg of items) {
      if (!msg || typeof msg !== 'object') continue;
      const isNotification = msg.id === undefined || msg.id === null;
      const result = isNotification ? null : await handleMcpRequest(msg, {
        loaded: state.loaded,
        cacheDir: state.cacheDir,
        offline: state.offline,
        embedFn: state.embedFn,
      });
      if (result) responses.push(result);
      else if (!isNotification && msg.method === undefined) continue;
    }

    // session id: mint on first contact, echo afterwards
    const requested = req.headers['mcp-session-id'];
    if (typeof requested === 'string' && requested) state.mcpSessionId = requested;
    if (!state.mcpSessionId) state.mcpSessionId = crypto.randomUUID();
    res.setHeader('mcp-session-id', state.mcpSessionId);

    // protocol negotiation: honour a supported requested version, else latest
    for (const resp of responses) {
      if (resp?.result?.protocolVersion && msg0(items)?.params?.protocolVersion) {
        const wanted = String(msg0(items).params.protocolVersion);
        const SUPPORTED = ['2025-03-26', '2024-11-05'];
        resp.result.protocolVersion = SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0];
      }
    }

    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    json(res, 200, batch ? responses : responses[0]);
  } finally {
    release();
  }
}

/** First object of a (possibly single-message) payload — for init negotiation. */
function msg0(items: any[]): any | null {
  return items.length > 0 ? items[0] : null;
}

function json(res: http.ServerResponse, status: number, data: object): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Security headers on EVERY response (issue #120)
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/** Serve a web-UI asset with the same security headers + a strict CSP (issue #111). */
function sendAsset(res: http.ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    // no inline script/style anywhere in the UI -> nothing needs unsafe-*
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

export { DEFAULT_PORT, DEFAULT_HOST, MAX_BODY_BYTES, WATCH_INTERVAL_MS };


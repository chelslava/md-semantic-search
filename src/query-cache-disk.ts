/**
 * Disk-backed persistent query-embedding cache (issue #114).
 *
 * The in-memory QueryEmbeddingCache only helps long-lived processes; every
 * fresh `mdss search` paid full embedding latency. This module adds an L2
 * layer under it: an LRU (512 entries) persisted to `<cacheDir>/query-cache.json`
 * keyed by model@revision|dim|sha256(query) — the same identity the memory
 * cache uses, hashed for compactness.
 *
 * Integrity mirrors vectors.bin: atomic tmp+rename write plus a `.sha256`
 * sidecar. A missing/corrupt pair is silently ignored and rebuilt — a broken
 * cache must never fail a search.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const QUERY_CACHE_FILE = 'query-cache.json';
export const QUERY_CACHE_MAX_ENTRIES = 512;

export function buildDiskKey(modelId: string, revision: string, dim: number | undefined, query: string): string {
  const norm = query.trim().toLowerCase();
  return `${modelId}@${revision || 'main'}|${dim ?? 0}|${crypto.createHash('sha256').update(norm).digest('hex')}`;
}

interface StoredEntry {
  /** base64 little-endian Float32 payload (encodeVec format). */
  vec: string;
  dim: number;
  ts: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, StoredEntry>;
}

/** Per-directory in-process state: loaded entries + dirty flag. */
const states = new Map<string, { entries: Map<string, StoredEntry>; dirty: boolean; timer?: NodeJS.Timeout }>();

function stateFor(cacheDir: string) {
  let st = states.get(cacheDir);
  if (!st) {
    st = { entries: loadFromDisk(cacheDir), dirty: false };
    states.set(cacheDir, st);
  }
  return st;
}

function filePaths(cacheDir: string) {
  const file = path.join(cacheDir, QUERY_CACHE_FILE);
  return { file, sha: `${file}.sha256`, tmp: `${file}.tmp-${process.pid}` };
}

function loadFromDisk(cacheDir: string): Map<string, StoredEntry> {
  const out = new Map<string, StoredEntry>();
  const { file, sha } = filePaths(cacheDir);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return out;
  }
  try {
    if (fs.existsSync(sha)) {
      const expected = fs.readFileSync(sha, 'utf8').trim().split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(raw).digest('hex');
      if (!expected || expected !== actual) return out; // corrupt → silent rebuild
    }
    const parsed = JSON.parse(raw.toString('utf8')) as CacheFile;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object') return out;
    for (const [key, e] of Object.entries(parsed.entries)) {
      if (
        typeof key === 'string' &&
        typeof e?.vec === 'string' &&
        Number.isInteger(e?.dim) &&
        (e.dim as number) > 0 &&
        Number.isFinite(e?.ts)
      ) {
        out.set(key, { vec: e.vec, dim: e.dim, ts: e.ts });
      }
    }
  } catch {
    return new Map(); // any corruption → treat as empty; next flush overwrites
  }
  return out;
}

function flushSync(cacheDir: string): void {
  const st = states.get(cacheDir);
  if (!st || !st.dirty) return;
  // LRU trim before writing
  const sorted = [...st.entries.entries()].sort((a, b) => b[1].ts - a[1].ts);
  st.entries = new Map(sorted.slice(0, QUERY_CACHE_MAX_ENTRIES));
  const payload: CacheFile = {
    version: 1,
    entries: Object.fromEntries(st.entries),
  };
  const body = Buffer.from(JSON.stringify(payload));
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const { file, sha, tmp } = filePaths(cacheDir);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    fs.writeFileSync(`${sha}.tmp`, `${digest}  ${QUERY_CACHE_FILE}\n`);
    fs.renameSync(`${sha}.tmp`, sha);
    st.dirty = false;
  } catch {
    /* unwritable cacheDir is non-fatal by design */
  }
}

function scheduleFlush(cacheDir: string): void {
  const st = stateFor(cacheDir);
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = undefined;
    flushSync(cacheDir);
  }, 400);
  st.timer.unref?.();
}

// best-effort flush on process exit so one-shot CLI runs persist their queries
let exitHookInstalled = false;
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of states.keys()) flushSync(dir);
  });
}

/**
 * Look up a query vector on disk. Returns null on any miss/corruption —
 * callers fall through to embedding without ceremony.
 */
export function diskQueryGet(
  cacheDir: string | undefined,
  key: string,
  expectedDim: number | undefined,
): Float32Array | null {
  if (!cacheDir) return null;
  const st = stateFor(cacheDir);
  const e = st.entries.get(key);
  if (!e) return null;
  try {
    const buf = Buffer.from(e.vec, 'base64');
    if (buf.byteLength !== e.dim * 4) return null;
    const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (expectedDim !== undefined && arr.length !== expectedDim) return null;
    for (const x of arr) if (!Number.isFinite(x)) return null;
    e.ts = Date.now(); // LRU touch
    st.dirty = true;
    scheduleFlush(cacheDir);
    return arr;
  } catch {
    st.entries.delete(key);
    return null;
  }
}

/** Store a computed query vector (fire-and-forget, debounced flush). */
export function diskQueryPut(
  cacheDir: string | undefined,
  key: string,
  vec: number[] | Float32Array,
): void {
  if (!cacheDir) return;
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const st = stateFor(cacheDir);
  st.entries.set(key, {
    vec: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64'),
    dim: f32.length,
    ts: Date.now(),
  });
  st.dirty = true;
  ensureExitHook();
  scheduleFlush(cacheDir);
}

/** Test helper: force-write now. */
export function flushQueryCacheNow(cacheDir: string): void {
  flushSync(cacheDir);
}

/** Test helper: forget in-process state so the next get/put reloads from disk. */
export function resetQueryCacheForTest(cacheDir?: string): void {
  if (cacheDir) states.delete(cacheDir);
  else states.clear();
}

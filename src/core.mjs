// @ts-check
/**
 * Core helpers: model loading, embeddings, markdown walking + chunking, cosine.
 * Fully model- and path-agnostic — everything is driven by explicit arguments
 * so the same code works on any folder of .md files, anywhere on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModel } from './models.mjs';
import { chunkMarkdownStructural, PARSER_VERSION } from './markdown-parser.mjs';

export { PARSER_VERSION };

const _extractors = new Map();

// --- index write lock (issue #37) -------------------------------------------
// vectors.json and .hashes.json are written by two separate atomic renames
// (buildIndex's atomicWrite); between them a second `mdss index`/`serve
// --watch` run can interleave and leave the pair from DIFFERENT runs — a torn
// logical state. A lockfile in the index dir serializes writers: the holder
// takes it before any read-compute-write and releases it in a finally. There
// is intentionally no flock/LOCK_EX — advisory cooperation is enough (all
// writers are ours), and O_EXCL file creation is the portable atomic primitive.

/** Name of the lock file inside the index dir. */
export const LOCK_FILENAME = '.mdss.lock';

/** Locks older than this are presumed abandoned and reclaimed (ms). */
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * True when `pid` refers to a live process we can signal. `process.kill(pid, 0)`
 * performs no signal — it just probes; it throws ESRCH when the pid is gone,
 * EPERM when it exists but is owned by another user (counted as alive here —
 * we must NOT steal a live owner's lock).
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** Parse + validate a .mdss.lock body; returns null when unreadable/garbage. */
function readLock(lockPath) {
  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf8'); }
  catch { return null; }
  try {
    const j = JSON.parse(raw);
    if (!Number.isInteger(j.pid) || typeof j.since !== 'string') return null;
    return j;
  } catch { return null; }
}

/**
 * Try to take the index lock; never throws for a held lock.
 * @param {string} indexDir
 * @returns {{ acquired: true, lockPath: string } | { acquired: false, reason: string, pid: (number|null), heldSince: (string|null) }}
 *   `acquired:false` carries enough context for an actionable error/log line.
 */
export function acquireIndexLock(indexDir) {
  const lockPath = path.join(indexDir, LOCK_FILENAME);
  const payload = JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');            // O_EXCL — atomic create-or-fail
      fs.writeFileSync(fd, payload);
      return { acquired: true, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw new Error(`cannot create index lock ${lockPath}: ${e.message}`);
      }
      // Lock exists — decide whether its holder is still alive / fresh.
      let stat = null;
      try { stat = fs.statSync(lockPath); } catch { /* raced — holder released between our open and stat */ }
      const info = readLock(lockPath);
      const pid = info?.pid ?? null;
      const heldSince = info?.since ?? null;
      // Garbage body → treat as abandoned (a crashed pre-lock-format writer).
      const garbage = info === null;
      const dead = pid !== null && !pidAlive(pid);
      const staleMs = stat ? (Date.now() - stat.mtimeMs) : 0;
      if ((garbage || dead || staleMs > LOCK_STALE_MS) && stat) {
        // Reclaim: unlink then loop to retry acquisition. The unlink is safe
        // because the holder is provably dead/stale — a live owner never gets
        // its lock stolen.
        try { fs.unlinkSync(lockPath); } catch { /* raced reclaim — someone else got it */ }
        continue;                                     // retry O_EXCL create
      }
      return {
        acquired: false,
        reason: garbage
          ? 'lock file is unreadable/abandoned'
          : dead
          ? `lock held by dead pid ${pid} (since ${heldSince})`
          : `index is being written by pid ${pid ?? '?'} (since ${heldSince ?? 'unknown'})`,
        pid, heldSince,
      };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
  }
  return { acquired: false, reason: 'lock reclaimed by another process during retry', pid: null, heldSince: null };
}

/** Release the index lock held by THIS process; safe to call twice. */
export function releaseIndexLock(indexDir) {
  try { fs.unlinkSync(path.join(indexDir, LOCK_FILENAME)); }
  catch { /* already released / never held */ }
}

/**
 * Run `fn` under the index write lock, releasing it in a finally (crash-safe:
 * the pid-liveness/staleness checks above reclaim a lock abandoned by a killed
 * holder, so a hard exit cannot wedge the index forever).
 * @template T
 * @param {string} indexDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @throws when the lock is already held (see the error message for pid/since).
 */
export async function withIndexLock(indexDir, fn) {
  // The lock file lives IN the index dir, so the dir must exist before the
  // O_EXCL create — and callers (serve) legitimately call a build on a fresh
  // dir. Create it here, idempotently, BEFORE acquiring so the lock guards the
  // whole build including the very first write.
  fs.mkdirSync(indexDir, { recursive: true });
  const r = acquireIndexLock(indexDir);
  if (!r.acquired) throw new Error(/** @type {{reason:string}} */(r).reason);
  try { return await fn(); }
  finally { releaseIndexLock(indexDir); }
}

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} id - HF repo id (e.g. "Xenova/multilingual-e5-base")
 * @property {string} [revision] - pinned revision (default "main")
 * @property {number} [dim] - embedding dimension (0 for custom ids)
 * @property {string} [queryPrefix] - E5-style "query: " prefix ('' for bge)
 * @property {string} [passagePrefix] - E5-style "passage: " prefix ('' for bge)
 * @property {import('./models.mjs').Pooling} [pooling] - token pooling strategy (default "mean")
 * @property {boolean} [normalize] - whether vectors are L2-normalized (default true)
 * @property {import('./models.mjs').DType} [dtype] - runtime ONNX dtype (default "q8")
 * @property {number} [maxTokens] - declared tokenizer budget (context window)
 * @property {Record<string, unknown>} [sessionOptions] - ONNX Runtime session options (e.g. intraOpNumThreads)
 * @property {boolean} [unknownAdapter] - true for unconfigured raw ids that
 *   cannot embed until an explicit adapter is supplied (issue #60)
 * @property {string} [note] - human-readable description
 */

/**
 * Select the Transformers.js pipeline source for a model load.
 * @param {ModelDescriptor} model
 * @param {string} cacheDir
 * @param {boolean} offline
 * @returns {string}
 */
export function getPipelineModelSource(model, cacheDir, offline) {
  const revision = model.revision || 'main';
  return offline && revision !== 'main'
    ? path.join(cacheDir, model.id, revision)
    : model.id;
}

/**
 * Resolve ONNX Runtime session options from model adapter or environment variables (issue #34).
 * @param {ModelDescriptor} [model]
 * @returns {Record<string, unknown>|undefined}
 */
export function resolveSessionOptions(model) {
  const envIntra = process.env.MDSS_INTRA_OP_THREADS || process.env.MDSS_NUM_THREADS;
  const envInter = process.env.MDSS_INTER_OP_THREADS;
  const intra = envIntra ? parseInt(envIntra, 10) : undefined;
  const inter = envInter ? parseInt(envInter, 10) : undefined;
  const opts = model?.sessionOptions || {};
  const intraOpNumThreads = Number.isSafeInteger(intra) && intra > 0 ? intra : opts.intraOpNumThreads;
  const interOpNumThreads = Number.isSafeInteger(inter) && inter > 0 ? inter : opts.interOpNumThreads;

  if (intraOpNumThreads === undefined && interOpNumThreads === undefined) {
    return undefined;
  }
  /** @type {Record<string, unknown>} */
  const result = {};
  if (intraOpNumThreads !== undefined) result.intraOpNumThreads = intraOpNumThreads;
  if (interOpNumThreads !== undefined) result.interOpNumThreads = interOpNumThreads;
  return result;
}

/**
 * Get the in-memory cache key for a pipeline extractor session.
 * @param {ModelDescriptor} model
 * @param {string} cacheDir
 * @param {boolean} [offline]
 * @returns {string}
 */
export function getExtractorCacheKey(model, cacheDir, offline) {
  const revision = model.revision || 'main';
  const source = getPipelineModelSource(model, cacheDir, offline);
  const sessionOptions = resolveSessionOptions(model);
  const sessionKey = sessionOptions ? JSON.stringify(sessionOptions) : 'default';
  return `${model.id}@${revision}|${offline ? 'off' : 'on'}|${source}|${sessionKey}`;
}

/**
 * Lazily load (and cache) a feature-extraction pipeline for a model.
 * A neutral unknown-raw-id adapter is rejected here with an actionable message
 * (issue #60) — the model name is never guessed to be E5/BGE compatible.
 * @param {ModelDescriptor} model - resolved adapter from resolveModel()
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 */
export async function getExtractor(model, cacheDir, offline = false) {
  if (model.unknownAdapter === true) {
    throw new Error(
      `model "${model.id}" is not a registered adapter and has no explicit ` +
      'configuration, so it cannot embed safely (no E5 prefixes / pooling are ' +
'guessed). Register it in MODELS or pass an explicit adapter descriptor ' +
      '(see README "How to add a model") — e.g. for a raw id, supply ' +
      'queryPrefix/passagePrefix/dim/pooling explicitly.',
  );
  }
  const revision = model.revision || 'main';
  const source = getPipelineModelSource(model, cacheDir, offline);
  const key = getExtractorCacheKey(model, cacheDir, offline);
  if (_extractors.has(key)) return _extractors.get(key);
  const { pipeline, env } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  env.allowRemoteModels = !offline;
  const sessionOptions = resolveSessionOptions(model);
  // Use the adapter-declared runtime dtype (default q8 — the v4 default on Node
  // is fp32, ~4x larger). The declared dtype is part of the runtime load, not
  // of the vector-producing fingerprint, so a dtype change alone does not
  // invalidate stored vectors.
  const pipeOpts = {
    revision,
    dtype: model.dtype || 'q8',
    ...(sessionOptions ? { session_options: sessionOptions } : {}),
  };
  const ext = await pipeline('feature-extraction', source, pipeOpts);
  _extractors.set(key, ext);
  return ext;
}

/**
 * Prepare model-specific feature-extraction inputs and invocation options.
 * All vector-producing semantics come from the resolved adapter (issue #60):
 * query/document formatting, pooling, and normalization are read from the
 * descriptor, never inferred from the model name.
 * @param {ModelDescriptor} model - resolved adapter from resolveModel()
 * @param {string[]} texts
 * @param {'query'|'passage'} kind
 * @returns {{input:string[], options:{pooling:import('./models.mjs').Pooling, normalize:boolean}}}
 */
export function prepareEmbeddingRequest(model, texts, kind) {
  if (model.unknownAdapter === true) {
    throw new Error(
      `model "${model.id}" is not a registered adapter and has no explicit ` +
      'configuration, so it cannot embed safely (issue #60) — supply an ' +
      'explicit adapter descriptor, see README "How to add a model".',
    );
  }
  const prefix = kind === 'query' ? model.queryPrefix : model.passagePrefix;
  const input = prefix ? texts.map(text => prefix + text) : texts;
  return {
    input,
    options: { pooling: model.pooling ?? 'mean', normalize: model.normalize !== false },
  };
}

/**
 * Embed texts with the given model descriptor.
 * @param {string[]} texts
 * @param {'query'|'passage'} kind
 * @param {ModelDescriptor} model - descriptor from resolveModel()
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 * @returns {Promise<number[][]>} L2-normalized vectors
 */
export async function embed(texts, kind, model, cacheDir, offline = false) {
  const ext = await getExtractor(model, cacheDir, offline);
  const { input, options } = prepareEmbeddingRequest(model, texts, kind);
  const out = await ext(input, options);
  return out.tolist();
}

/** Cosine similarity for L2-normalized vectors == dot product. Supports offset in contiguous buffer (issue #30). */
export function cosine(a, b, bOffset = 0) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[bOffset + i];
  return s;
}

/**
 * Encode a numeric vector as a base64 string of its Float32Array bytes
 * (binary vector storage, issue #4). ~4× smaller than decimal JSON: a 768-dim
 * vector is 3072 raw bytes → 4096 base64 chars, vs ~8-10 chars per number.
 * @param {number[]|Float32Array} vec
 * @returns {string}
 */
export function encodeVec(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/**
 * Decode a base64 vector string back to a Float32Array (binary storage, #4).
 *
 * Throws on corrupt input instead of silently producing garbage (issue #40):
 * - base64 whose byte length is not a multiple of 4 — a truncated string would
 *   previously decode into a truncated Float32Array (wrong dim, silent NaN
 *   scores downstream);
 * - non-finite values (NaN/Infinity) — e.g. from a partial write or bit rot.
 *
 * When `dim` is given, a length mismatch is also rejected.
 * @param {string} s
 * @param {number} [dim] - expected vector length (issue #40)
 * @returns {Float32Array}
 */
export function decodeVec(s, dim) {
  if (s.length === 0) {
    throw new Error('corrupt base64 vector: empty value — run `mdss index` to rebuild');
  }
  if (s.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new Error('corrupt base64 vector: encoding is not canonical — ' +
      'run `mdss index` to rebuild');
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) {
    throw new Error('corrupt base64 vector: encoding is not canonical — ' +
      'run `mdss index` to rebuild');
  }
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `corrupt base64 vector: ${buf.byteLength} bytes is not a multiple of 4 ` +
      `(a float32 is 4 bytes) — run \`mdss index\` to rebuild`);
  }
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (dim !== undefined && vec.length !== dim) {
    throw new Error(`corrupt vector: ${vec.length} dims, expected ${dim} — ` +
      `run \`mdss index\` to rebuild`);
  }
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      throw new Error(`corrupt vector: non-finite value at index ${i} ` +
        `(NaN/Infinity) — run \`mdss index\` to rebuild`);
    }
  }
  return vec;
}

/**
 * True when the index uses the binary vector format (vec stored as base64).
 * @param {{format?:string}} index - parsed vectors.json
 * @returns {boolean}
 */
export function isBinaryIndex(index) {
  return index.format === 'binary-v1';
}

/** @param {unknown} value @returns {number} */
export function parseSchemaVersion(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('schemaVersion must be a non-negative safe integer — ' +
      'run `mdss index` to rebuild');
  }
  return value;
}

/**
 * @param {unknown} stored
 * @param {number} known
 * @returns {number|undefined}
 */
export function resolveIndexDimension(stored, known) {
  if (stored !== undefined) {
    if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored <= 0) {
      throw new Error('index.dim must be a positive safe integer — ' +
        'run `mdss index` to rebuild');
    }
    if (known > 0 && stored !== known) {
      throw new Error(`index.dim ${stored} does not match known model dimension ${known} — ` +
        'run `mdss index` to rebuild');
    }
    return stored;
  }
  return known > 0 ? known : undefined;
}

/**
 * Index schema version (issue #39). Bump on every breaking change to
 * vectors.json and add a migration step to SCHEMA_MIGRATIONS.
 *   v0 (implicit): everything written before schemaVersion existed — the
 *     loader's format heuristics (decimal vs binary-v1 vecs, missing model
 *     field, missing chunkHash, vec-less chunks) already handle all v0 shapes.
 *   v1: first explicit version; written by all builds since 0.6.0.
 *   v2: chunks persist leaf-inclusive headingPath for contextual embeddings.
 *   v3: vectors.json requires an embedded BM25 lexical index.
 */
export const SCHEMA_VERSION = 3;

/**
 * Mark a legacy index as schema v2 without inventing heading paths it never
 * stored. Legacy readers remain usable; the indexer performs the honest
 * contextual rebuild before it persists schema-v2 chunks.
 * @param {{schemaVersion?:number}} index
 */
export function migrateToSchemaV2(index) {
  index.schemaVersion = 2;
}

/** Schema-v3 is a format declaration; only a rebuild may write it. */
export function migrateToSchemaV3() {}

/**
 * Migration table: `SCHEMA_MIGRATIONS[n]` upgrades an index at schema n-1 → n.
 * Read by loadIndex/buildIndex before use; writing a version newer than the
 * binary supports is a hard error instead of a silent misparse (issue #39).
 * @type {Record<number, (index: object) => void>}
 */
export const SCHEMA_MIGRATIONS = {
  // v0 → v1: no structural change — legacy shapes (decimal vecs, missing
  // model/chunkHash, vec-less chunks) are normalized by the loaders' existing
  // format heuristics, not by a data rewrite. This entry exists so the table
  // is explicit: every future format change adds a real step here + a test.
  1: () => {},
  2: migrateToSchemaV2,
  3: migrateToSchemaV3,
};

/** Recursively collect .md/.markdown files under dir, honoring ignore globs. */
export function walkMarkdown(dir, ignore = []) {
  const out = [];
  const ignoreRe = ignore.map(globToRegExp);
  const walk = (cur) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.name.startsWith('.')) continue; // skip dotfiles/dotdirs (.git, .mdss…)
      if (ignoreRe.some(re => re.test(rel) || re.test(e.name))) continue;
      if (e.isDirectory()) walk(full);
      else if (/\.(md|markdown)$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Validate that targetPath resolves within allowed root directories.
 * @param {string} targetPath
 * @param {string[]} [allowedRoots]
 * @returns {string} canonical absolute path
 */
export function assertSafePath(targetPath, allowedRoots) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('path must be a non-empty string');
  }
  const resolved = path.resolve(targetPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    // path may not exist yet (e.g. fresh index dir)
  }

  let roots = allowedRoots;
  if (!roots || roots.length === 0) {
    if (process.env.MDSS_ROOT_GUARD) {
      roots = process.env.MDSS_ROOT_GUARD.split(path.delimiter).map(p => path.resolve(p.trim())).filter(Boolean);
    } else {
      roots = [path.resolve(process.cwd())];
      try {
        const home = os.homedir();
        if (home) roots.push(path.resolve(home));
      } catch {}
      try {
        const tmp = os.tmpdir();
        if (tmp) roots.push(path.resolve(tmp));
      } catch {}
    }
  }

  const isAllowed = roots.some(root => {
    let canonicalRoot = root;
    try { canonicalRoot = fs.realpathSync(root); } catch {}
    const rel = path.relative(canonicalRoot, canonical);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!isAllowed) {
    throw new Error(`path traversal guard: "${targetPath}" (resolving to "${canonical}") is outside allowed directory roots`);
  }

  return canonical;
}

/** Validate glob pattern for forbidden regex control characters. */
export function validateGlob(glob) {
  if (typeof glob !== 'string') throw new Error('glob must be a string');
  if (/[|()$`{}]/.test(glob)) {
    const match = glob.match(/[|()$`{}]/);
    throw new Error(`invalid glob pattern "${glob}": forbidden character "${match ? match[0] : ''}"`);
  }
  return glob;
}

/** Minimal glob → RegExp (supports * and **). */
export function globToRegExp(glob) {
  validateGlob(glob);
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')      // placeholder for **
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

/** Strip YAML frontmatter → { frontmatter, body }. */
export function splitFrontmatter(raw) {
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      return {
        frontmatter: raw.slice(3, end).trim(),
        body: raw.slice(end + 4).replace(/^\s*\n/, ''),
      };
    }
  }
  return { frontmatter: '', body: raw };
}

export function extractTitle(frontmatter, body, relPath) {
  const fmTitle = frontmatter.match(/^title:\s*(.+)$/m);
  if (fmTitle) return fmTitle[1].trim().replace(/^["']|["']$/g, '');
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(relPath).replace(/\.(md|markdown)$/i, '');
}

const DEFAULT_MAX_CHUNK = 1400; // chars; ~350-450 tokens, fits e5/bge context

/**
 * Chunk markdown structurally by headings and atomic block boundaries (issue #57).
 * Oversized sections split further on block boundaries and hard wraps.
 * @param {string} body
 * @param {number} [maxChunk=DEFAULT_MAX_CHUNK]
 * @returns {import('./markdown-parser.mjs').StructuralChunk[]}
 */
export function chunkMarkdown(body, maxChunk = DEFAULT_MAX_CHUNK) {
  return chunkMarkdownStructural(body, maxChunk);
}

import { parseFrontmatter } from './frontmatter.mjs';

export { parseFrontmatter };

/**
 * Parse one file into title + chunk records (no embeddings yet).
 * @param {string} absPath - absolute file path
 * @param {string} dbDir - base dir (for relative file labels)
 * @param {number} [maxChunk] - chunk size cap (defaults to DEFAULT_MAX_CHUNK)
 * @param {string} [raw] - already-read file content. When given, the file is
 *   NOT read from disk again (issue #35: buildIndex already read it for the
 *   md5 fast-path check, so a changed file was being read twice).
 * @returns {{file:string, title:string, heading:string, headingPath:string[], text:string, startLine?:number, endLine?:number, meta?:import('./frontmatter.mjs').DocumentMetadata}[]}
 */
export function parseFile(absPath, dbDir, maxChunk, raw) {
  const content = raw ?? fs.readFileSync(absPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);
  const rel = path.relative(dbDir, absPath).split(path.sep).join('/');
  const title = meta.title || extractTitle(frontmatter, body, rel);
  const frontmatterLineCount = frontmatter ? frontmatter.split('\n').length + 2 : 0;
  return chunkMarkdown(body, maxChunk).map(c => {
    const heading = c.heading || title;
    return {
      file: rel,
      title,
      heading,
      headingPath: c.headingPath.length > 0 ? c.headingPath : [heading],
      text: c.text,
      startLine: (c.startLine || 1) + frontmatterLineCount,
      endLine: (c.endLine || 1) + frontmatterLineCount,
      meta,
    };
  });
}

export { resolveModel };

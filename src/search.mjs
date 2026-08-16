// @ts-check
/**
 * Hybrid semantic + lexical search over a prebuilt index. Schema-v3 uses
 * persisted BM25 postings; schema-v0/v1/v2 retain exact token overlap.
 * Both lexical lanes fuse with cosine ranking through Reciprocal Rank Fusion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { embed, cosine, decodeVec, globToRegExp, walkMarkdown } from './core.mjs';
import { validateIndexEnvelope, validateNumericVector } from './index-format.mjs';
import { rerankScores } from './rerank.mjs';
import { bm25Scores, matchingTerms, tokenize, fuzzyTitleAliasScores } from './lexical.mjs';
import { collapseResults } from './collapse.mjs';
export { tokenize } from './lexical.mjs';

// In-memory token-set cache for the lexical lane (issue #18). Tokenizing the
// corpus is a pure function of the chunk texts — but keywordScores used to
// re-tokenize ~1400 chars × chunk-count on EVERY query (~28M chars per query
// at the documented 10–20k chunk scale). A token Set is computed lazily once
// per CHUNK OBJECT and cached in a WeakMap, so sets survive across searchIndex
// calls AND across filtered views (--path/--since produce a new chunks ARRAY
// per query but the chunk OBJECTS are shared — caching per array would
// re-tokenize every filtered query; per chunk object never does), and are
// dropped with the index itself (no invalidation logic: one-shot CLI exits,
// serve replaces the whole `loaded` on re-index). Entries are shared-but-
// never-mutated after construction, so concurrent awaits are safe.
const chunkTokens = new WeakMap();
// Test observability (issue #18 acceptance criterion "tokenize ONCE"): total
// CHUNK-text characters tokenized through the cache (query tokens excluded).
// Exported for tests only — not part of the public API.
export const _stats = { corpusTokenizedChars: 0 };

/**
 * Get (or lazily build) the token Set for one chunk. Cached per chunk object.
 * @param {IndexChunk} c
 * @returns {Set<string>}
 */
function tokenSet(c) {
  let s = chunkTokens.get(c);
  if (!s) {
    const text = `${c.title} ${c.heading} ${c.text}`;
    _stats.corpusTokenizedChars += text.length;
    s = new Set(tokenize(text));
    chunkTokens.set(c, s);
  }
  return s;
}

/**
 * Legacy compatibility helper for schema-v0/v1/v2 and public API consumers.
 * Scores by TOKEN OVERLAP (set intersection of query terms vs chunk
 * terms), not substring. "win" must NOT match "window", "token" must NOT match
 * "tokens" — only exact token overlap counts (issue #7). The haystack is
 * tokenized once per chunk (issue #18 — cached per loaded index, not per
 * query) with the same tokenize() as the query.
 * @returns {number[]} per-chunk count of overlapping unique terms
 */
export function keywordScores(chunks, query) {
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return chunks.map(() => 0);
  return chunks.map(c => {
    const hay = tokenSet(c);
    let s = 0;
    for (const t of qTerms) if (hay.has(t)) s++;
    return s;
  });
}

/** Reciprocal Rank Fusion. rankings: arrays of {idx, score}; higher = better. */
export function rrf(rankings, k = 60) {
  const fused = new Map();
  for (const ranking of rankings) {
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    let scoreRank = 0;
    sorted.forEach((item, rank) => {
      if (item.score <= 0) return;
      if (rank > 0 && item.score < sorted[rank - 1].score) scoreRank = rank;
      fused.set(item.idx, (fused.get(item.idx) || 0) + 1 / (k + scoreRank + 1));
    });
  }
  return fused;
}

/**
 * @typedef {Object} IndexChunk
 * @property {string} file
 * @property {string} title
 * @property {string} heading
 * @property {string[]} [headingPath] - absent only on readable schema-v0/v1 indexes
 * @property {string} text
 * @property {number[]|Float32Array} vec
 * @property {string} [chunkHash]
 * @property {number} [startLine]
 * @property {number} [endLine]
 * @property {import('./frontmatter.mjs').DocumentMetadata} [meta]
 */

/**
 * @typedef {Object} IndexFile
 * @property {string} [format]
 * @property {number} [schemaVersion]
 * @property {string} [model]
 * @property {string} [modelAlias]
 * @property {number} [dim]
 * @property {string} [built]
 * @property {number} [chunkCount]
 * @property {string} [db] - markdown base the index was built from (issue #13 --since)
 * @property {import('./lexical.mjs').LexicalIndex} [lexical]
 * @property {IndexChunk[]} chunks
 */

/**
 * Bounded LRU cache for query vectors in daemon/serve mode (issue #33).
 */
export class QueryEmbeddingCache {
  /**
   * @param {number} [maxSize=100]
   */
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    /** @type {Map<string, Float32Array>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<Float32Array>>} */
    this.inFlight = new Map();
  }

  /**
   * @param {string} key
   * @returns {Float32Array|undefined}
   */
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, /** @type {Float32Array} */ (value));
    return value;
  }

  /**
   * @param {string} key
   * @param {number[]|Float32Array} vector
   */
  set(key, vector) {
    if (!Array.isArray(vector) && !(vector instanceof Float32Array)) return;
    if (vector.length === 0) return;
    const arr = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) return;
    }
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, arr);
  }

  /**
   * Get or compute with coalescing of concurrent in-flight requests.
   * @param {string} key
   * @param {() => Promise<number[]|Float32Array>} fn
   * @returns {Promise<Float32Array>}
   */
  async getOrCompute(key, fn) {
    const cached = this.get(key);
    if (cached) return cached;
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    const promise = (async () => {
      try {
        const raw = await fn();
        this.set(key, raw);
        const stored = this.get(key);
        if (stored) return stored;
        return raw instanceof Float32Array ? raw : Float32Array.from(raw);
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  clear() {
    this.cache.clear();
    this.inFlight.clear();
  }

  get size() {
    return this.cache.size;
  }
}

/** @typedef {{kind:'persisted-bm25', lexical:import('./lexical.mjs').LexicalIndex}|{kind:'legacy-overlap'}} LexicalState */
/** @typedef {{file:string, title:string, heading:string, headingPath?:string[], text:string, startLine?:number, endLine?:number, meta?:import('./frontmatter.mjs').DocumentMetadata, vec:Float32Array}} RuntimeChunk */
/** @typedef {{schema:number, db:(string|undefined), chunks:RuntimeChunk[], lexicalState:LexicalState,
 *   expectedDim:(number|undefined), model:import('./core.mjs').ModelDescriptor, queryCache:QueryEmbeddingCache}} RuntimeIndexState */

const runtimeIndexStates = new WeakMap();

/**
 * Copy exactly the state consumed by search. The public index remains mutable
 * for compatibility, but no search reads it after this snapshot is created.
 * @param {IndexFile} index
 * @param {{schema:number, dim:(number|undefined), model:import('./core.mjs').ModelDescriptor}} validation
 * @returns {RuntimeIndexState}
 */
function snapshotRuntimeIndex(index, validation) {
  const chunks = index.chunks.map(chunk => ({
    file: chunk.file,
    title: chunk.title,
    heading: chunk.heading,
    headingPath: chunk.headingPath,
    text: chunk.text,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    meta: chunk.meta,
    vec: Float32Array.from(chunk.vec),
  }));
  let lexicalState = /** @type {LexicalState} */ ({ kind: 'legacy-overlap' });
  if (validation.schema >= 3) {
    /** @type {Record<string, Array<[number, number]>>} */
    const postings = Object.create(null);
    for (const [term, posting] of Object.entries(index.lexical.postings)) {
      postings[term] = posting.map(([docId, frequency]) => [docId, frequency]);
    }
    lexicalState = {
      kind: 'persisted-bm25',
      lexical: {
        format: index.lexical.format,
        documentLengths: [...index.lexical.documentLengths],
        postings,
      },
    };
  }
  return {
    schema: validation.schema,
    db: index.db,
    chunks,
    lexicalState,
    expectedDim: validation.dim,
    model: { ...validation.model },
    queryCache: new QueryEmbeddingCache(100),
  };
}

/** @param {IndexFile} index @returns {RuntimeIndexState} */
function validateRuntimeIndex(index) {
  const cached = runtimeIndexStates.get(index);
  if (cached) return cached;
  const validated = validateIndexEnvelope(index, 'index', { encoding: 'loaded' });
  let expectedDim = validated.dim;
  if (validated.schema < 3) {
    for (let position = 0; position < index.chunks.length; position++) {
      const chunk = index.chunks[position];
      if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
        throw new Error(`chunk ${position} must be an object — run \`mdss index\` to rebuild`);
      }
      const where = chunk.file + (chunk.heading ? ` › ${chunk.heading}` : '');
      const length = validateNumericVector(chunk.vec, expectedDim, `chunk ${where}`);
      expectedDim ??= length;
    }
  }
  const state = snapshotRuntimeIndex(index, {
    schema: validated.schema,
    dim: expectedDim,
    model: validated.model,
  });
  runtimeIndexStates.set(index, state);
  return state;
}

/**
 * Warn (once, non-fatal) when the loaded index is older than the newest
 * change under the markdown base it was built from (issue #20). The index
 * stores both `db` and `built`, so a stale index is detectable without any
 * re-embedding — just an mtime walk. Search still runs on the stale snapshot.
 * @param {IndexFile} index
 */
function warnIfStale(index) {
  if (!index.db || !index.built) return;          // legacy index: nothing to compare
  const builtMs = Date.parse(index.built);
  if (!Number.isFinite(builtMs)) return;
  let newest = 0;
  try {
    for (const f of walkMarkdown(index.db)) {
      const st = fs.statSync(f);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  } catch {
    return;                                        // db gone/unreadable → stay silent
  }
  // Tolerance: `built` is an ISO string truncated to milliseconds, while
  // filesystem mtimes carry sub-millisecond precision (and some filesystems
  // round up). A file written right after `built` was captured — e.g. the
  // index build's own final write, or a same-second touch — must NOT look
  // stale. Only warn when the newest change is clearly AFTER the build (a few
  // seconds of grace), which is what a human means by "index is stale".
  if (newest <= builtMs + 5000) return;           // fresh within the grace period
  const mins = Math.max(1, Math.round((newest - builtMs) / 60000));
  process.stderr.write(
    `warning: index is ${mins} min older than the newest change in ${index.db}; ` +
    'run `mdss index` to refresh.\n');
}

/**
 * Parse + decode an index file once. Returns the raw index plus the resolved
 * model, so a library consumer can hold BOTH in memory across searches and
 * skip re-parsing vectors.json on every query (issue #2 / #14).
 * @param {string} indexDir
 * @returns {{index: IndexFile, model: import('./core.mjs').ModelDescriptor}}
 */
export function loadIndex(indexDir) {
  const vectorsPath = path.join(indexDir, 'vectors.json');
  if (!fs.existsSync(vectorsPath)) {
    throw new Error(`No index at ${vectorsPath}. Run \`mdss index\` first.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  } catch (e) {
    // Corrupt index file — name the file and the fix, no raw stack trace
    // (issue #20).
    throw new Error(
      `${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild.`);
  }
  const validated = validateIndexEnvelope(parsed, vectorsPath, { encoding: 'stored' });
  const index = /** @type {IndexFile} */ (validated.index);
  const { schema, model, dim: validatedDim } = validated;
  let expectedDim = validatedDim;

  // Validate the model the index was built with. Indexes written by v0.1.x have
  // no "model" field at all — warn instead of silently assuming a default.
  if (!index.model && !index.modelAlias) {
    process.stderr.write('warning: index has no "model" field (built by an old ' +
      'version); assuming the default model. Re-run `mdss index` to refresh.\n');
  }

  // v0.4.0+ stores vectors as base64 Float32Array (issue #4); legacy ≤0.3.x
  // indexes hold decimal arrays. Decode the binary format once up front so the
  // cosine sweep below always sees plain numbers. Dim validation runs for BOTH
  // shapes (issue #40): a wrong-length vector — from a truncated base64, a
  // mixed-model index, or a partial write — used to silently produce NaN
  // scores; now it fails loudly at load with the chunk's identity.
  for (let position = 0; position < index.chunks.length; position++) {
    const c = index.chunks[position];
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`chunk ${position} must be an object — run \`mdss index\` to rebuild`);
    }
    if (typeof c.vec === 'string') {
      if (index.format !== 'binary-v1') {
        throw new Error(`chunk ${c.file}: unexpected base64 vector in a legacy ` +
          `decimal index — run \`mdss index\` to rebuild`);
      }
      try {
        // decodeVec throws on corrupt base64 (truncated, non-finite, wrong dim)
        c.vec = decodeVec(c.vec, expectedDim);
        expectedDim ??= c.vec.length;
      } catch (e) {
        const where = c.file + (c.heading ? ` › ${c.heading}` : '');
        throw new Error(`chunk ${where}: ${e.message}`);
      }
    } else {
      const where = c.file + (c.heading ? ` › ${c.heading}` : '');
      const length = validateNumericVector(c.vec, expectedDim, `chunk ${where}`);
      expectedDim ??= length;
    }
  }

  warnIfStale(index);

  runtimeIndexStates.set(index, snapshotRuntimeIndex(index, { schema, dim: expectedDim, model }));

  return { index, model };
}

/**
 * Rank against an already-loaded index (see loadIndex). Reuses the parsed
 * chunks, so repeated calls never re-read or re-parse vectors.json.
 * @param {object} opts
 * @param {{index: IndexFile, model: import('./core.mjs').ModelDescriptor}} opts.loaded - from loadIndex()
 * @param {string} opts.cacheDir
 * @param {string} opts.query
 * @param {number} [opts.k=6]
 * @param {boolean} [opts.semanticOnly=false]
 * @param {boolean} [opts.offline=false] - never download the model; require a cached one
 * @param {string|string[]} [opts.path] - keep only chunks whose file matches
 *   any of these globs (issue #13)
 * @param {string|Date} [opts.since] - keep only chunks from files modified at
 *   or after this date (ISO string or Date; resolved against index.db, #13)
 * @param {boolean} [opts.rerank=false] - re-rank the candidate pool with a
 *   cross-encoder (issue #15). Costs a model load (~280MB) + one forward pass
 *   per candidate on the first query.
 * @param {number} [opts.rerankPool] - how many top candidates to re-rank
 *   (default: max(20, k*3)). Larger = better recall, slower.
 * @param {Function} [opts.rerankFn] - rerank override for tests/dependency
 *   injection; signature (query, texts, cacheDir, offline) => Promise<number[]>
 * @param {Function} [opts.embedFn] - embed override for tests/dependency injection;
 *   signature (texts, kind, model, cacheDir, offline) => Promise<number[][]>
 * @param {string|string[]} [opts.tag] - filter by tag(s) (issue #58)
 * @param {string} [opts.project] - filter by project (issue #58)
 * @param {string} [opts.type] - filter by document type (issue #58)
 * @param {string} [opts.status] - filter by status (issue #58)
 * @param {boolean} [opts.canonicalOnly] - filter canonical documents only (issue #58)
 * @param {Record<string, unknown>} [opts.custom] - custom metadata key-value filters (issue #58)
 * @param {boolean} [opts.explain] - include explain output (issue #59)
 * @param {number} [opts.maxPerFile] - cap max results per file (issue #45)
 * @param {number} [opts.maxPerDoc] - cap max results per document (issue #45)
 * @param {boolean} [opts.useQueryCache=true] - use query vector embedding cache (issue #33)
 * @returns {Promise<Array>} results with file, title, heading, cosine, score,
 *   matches (query terms found in the chunk, issue #13), snippet, and
 *   rerankScore when reranking was enabled (issue #15)
 */
export async function searchIndex(opts) {
  const {
    loaded, cacheDir, query, k = 6, semanticOnly = false,
    offline = false, path: pathFilter, since,
    rerank = false, rerankPool,
    tag, project, type, status, canonicalOnly, custom,
  } = opts;
  // `??` (not destructuring defaults): serve.mjs passes `embedFn: null` when
  // no override is given, and JS defaults only fire on `undefined` — using ??
  // here makes the real extractor/reranker the fallback for null AND undefined
  // (issue #23).
  const embedFn = opts.embedFn ?? embed;
  const rerankFn = opts.rerankFn ?? rerankScores;
  const { index } = loaded;
  const runtime = validateRuntimeIndex(index);
  const { chunks, db, lexicalState, expectedDim } = runtime;

  // Candidate filtering happens BEFORE embedding/ranking (issue #13): --path
  // globs, --since (file mtime), and frontmatter metadata filters (issue #58) shrink the sweep.
  const pathRes = pathFilter
    ? (Array.isArray(pathFilter) ? pathFilter : [pathFilter]).map(globToRegExp)
    : [];
  let sinceMs;
  if (since !== undefined) {
    sinceMs = since instanceof Date ? since.getTime() : Date.parse(String(since));
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since date: "${since}" (use YYYY-MM-DD or ISO 8601)`);
  }
  let candidates = chunks.map((chunk, idx) => ({ chunk, idx }));
  const hasMetaFilter = tag !== undefined || project !== undefined || type !== undefined ||
    status !== undefined || canonicalOnly !== undefined || custom !== undefined;

  if (pathRes.length > 0 || sinceMs !== undefined || hasMetaFilter) {
    if (sinceMs !== undefined && !db) {
      throw new Error('--since requires an index that knows its --db (index.db missing). Re-run `mdss index`.');
    }
    const mtimeCache = new Map();
    candidates = candidates.filter(({ chunk }) => {
      if (pathRes.length > 0 && !pathRes.some(re => re.test(chunk.file))) return false;
      if (sinceMs !== undefined) {
        let m = mtimeCache.get(chunk.file);
        if (m === undefined) {
          try { m = fs.statSync(path.join(db, chunk.file)).mtimeMs; }
          catch { m = -Infinity; } // file vanished → chunk no longer eligible
          mtimeCache.set(chunk.file, m);
        }
        if (m < sinceMs) return false;
      }
      if (tag !== undefined) {
        const reqTags = (Array.isArray(tag) ? tag : [tag]).map(t => String(t).toLowerCase().replace(/^#/, ''));
        const chunkTags = chunk.meta?.tags || [];
        if (!reqTags.every(rt => chunkTags.includes(rt))) return false;
      }
      if (project !== undefined && chunk.meta?.project !== project) return false;
      if (type !== undefined && chunk.meta?.type !== type) return false;
      if (status !== undefined && chunk.meta?.status !== status) return false;
      if (canonicalOnly && chunk.meta?.canonical === false) return false;
      if (custom && typeof custom === 'object') {
        for (const [k, v] of Object.entries(custom)) {
          if (chunk.meta?.custom?.[k] !== v) return false;
        }
      }
      return true;
    });
  }

  let qVec;
  if (opts.useQueryCache !== false && runtime.queryCache) {
    const cacheKey = `${runtime.model.id}:${runtime.model.revision || 'main'}:${expectedDim || 0}:${query.trim().toLowerCase()}`;
    qVec = await runtime.queryCache.getOrCompute(cacheKey, async () => {
      const [v] = await embedFn([query], 'query', runtime.model, cacheDir, offline);
      if ((Array.isArray(v) || v instanceof Float32Array) &&
          expectedDim !== undefined && v.length !== expectedDim) {
        throw new Error(`query vector has ${v.length} dims, expected ${expectedDim} — ` +
          'run `mdss index` to rebuild');
      }
      validateNumericVector(v, undefined, 'query vector');
      return v;
    });
  } else {
    const [v] = await embedFn([query], 'query', runtime.model, cacheDir, offline);
    if ((Array.isArray(v) || v instanceof Float32Array) &&
        expectedDim !== undefined && v.length !== expectedDim) {
      throw new Error(`query vector has ${v.length} dims, expected ${expectedDim} — ` +
        'run `mdss index` to rebuild');
    }
    validateNumericVector(v, undefined, 'query vector');
    qVec = v;
  }
  const queryTerms = [...new Set(tokenize(query))];

  const semantic = candidates.map(({ chunk, idx }) => {
    return { idx, score: cosine(qVec, chunk.vec) };
  });
  const cosByIdx = new Map(semantic.map(s => [s.idx, s.score]));

  // Candidate pool: without rerank we rank exactly k; with rerank we pull a
  // wider pool (default max(20, k*3)) and let the cross-encoder pick the best k.
  const pool = rerank ? (rerankPool || Math.max(20, k * 3)) : k;

  let ranked;
  if (semanticOnly) {
    ranked = [...semantic].sort((a, b) => b.score - a.score).slice(0, pool)
      .map(s => ({ idx: s.idx, fscore: s.score, cos: s.score }));
  } else {
    const kw = lexicalState.kind === 'persisted-bm25'
      ? [...bm25Scores(lexicalState.lexical, queryTerms,
        new Set(candidates.map(candidate => candidate.idx))).entries()]
        .map(([idx, score]) => ({ idx, score }))
      : keywordScores(candidates.map(candidate => candidate.chunk), query)
        .map((score, position) => ({ idx: candidates[position].idx, score }));

    const fuzzy = [...fuzzyTitleAliasScores(candidates.map(c => c.chunk), query).entries()]
      .map(([position, score]) => ({ idx: candidates[position].idx, score }));

    const fused = rrf([semantic, kw, fuzzy]);
    ranked = [...fused.entries()]
      .map(([idx, fscore]) => ({ idx, fscore, cos: cosByIdx.get(idx) }))
      .sort((a, b) => b.fscore - a.fscore)
      .slice(0, pool);
  }

  // Cross-encoder re-ranking (issue #15): score each candidate as a
  // (query, passage) pair, then keep the top-k by the pairwise score.
  if (rerank && ranked.length > 0) {
    const texts = ranked.map(r => chunks[r.idx].text);
    const scores = await rerankFn(query, texts, cacheDir, offline);
    ranked = ranked
      .map((r, i) => ({ ...r, rerank: scores[i] ?? -Infinity }))
      .sort((a, b) => b.rerank - a.rerank)
      .slice(0, k);
  }

  const hasMetaFields = (m) => Boolean(m && (m.tags?.length > 0 || m.aliases?.length > 0 || m.project || m.type || m.status || m.canonical !== undefined || m.canonicalRef || m.created || m.updated || Object.keys(m.custom || {}).length > 0));

  const explain = opts.explain === true;

  // V3 matches come from postings; legacy indexes reuse cached token sets.
  const hits = ranked.map(r => {
    const c = chunks[r.idx];
    const matches = lexicalState.kind === 'persisted-bm25'
      ? matchingTerms(lexicalState.lexical, queryTerms, r.idx)
      : queryTerms.filter(term => tokenSet(c).has(term));
    return {
      file: c.file,
      title: c.title,
      heading: c.heading,
      cosine: +r.cos.toFixed(3),
      score: +r.fscore.toFixed(4),
      matches,
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 220),
      ...(hasMetaFields(c.meta) ? { meta: c.meta } : {}),
      ...(explain ? { explain: { cosine: +r.cos.toFixed(4), rrfScore: +r.fscore.toFixed(4), bm25Weights: { title: 3.0, aliases: 3.0, headingPath: 1.8, body: 1.0 } } } : {}),
      ...(rerank ? { rerankScore: +(r.rerank ?? 0).toFixed(4) } : {}),
    };
  });

  const maxPerDoc = opts.maxPerFile || opts.maxPerDoc;
  if (maxPerDoc && maxPerDoc > 0) {
    return collapseResults(hits, h => h.meta?.canonical || h.file, maxPerDoc).slice(0, k);
  }
  return hits;
}

/**
 * One-shot search: parse the index, rank, return results. For repeated queries
 * in one process prefer loadIndex() + searchIndex() to skip re-parsing.
 * @param {object} opts
 * @param {string} opts.indexDir
 * @param {string} opts.cacheDir
 * @param {string} opts.query
 * @param {number} [opts.k=6]
 * @param {boolean} [opts.semanticOnly=false]
 * @param {boolean} [opts.offline=false] - never download the model; require a cached one
 * @param {string|string[]} [opts.path] - keep only chunks whose file matches
 *   any of these globs (issue #13)
 * @param {string|Date} [opts.since] - keep only chunks from files modified at
 *   or after this date (issue #13)
 * @param {boolean} [opts.rerank=false] - re-rank the candidate pool with a
 *   cross-encoder (issue #15)
 * @param {number} [opts.rerankPool] - candidate pool size for rerank
 * @param {Function} [opts.rerankFn] - rerank override for tests; signature
 *   (query, texts, cacheDir, offline) => Promise<number[]>
 * @param {Function} [opts.embedFn] - embed override for tests/dependency injection;
 *   signature (texts, kind, model, cacheDir, offline) => Promise<number[][]>
 * @param {string|string[]} [opts.tag] - filter by tag(s) (issue #58)
 * @param {string} [opts.project] - filter by project (issue #58)
 * @param {string} [opts.type] - filter by document type (issue #58)
 * @param {string} [opts.status] - filter by status (issue #58)
 * @param {boolean} [opts.canonicalOnly] - filter canonical documents only (issue #58)
 * @param {Record<string, unknown>} [opts.custom] - custom metadata key-value filters (issue #58)
 * @param {boolean} [opts.explain] - include explain output (issue #59)
 * @param {number} [opts.maxPerFile] - cap max results per file (issue #45)
 * @param {number} [opts.maxPerDoc] - cap max results per document (issue #45)
 * @param {boolean} [opts.useQueryCache=true] - use query vector embedding cache (issue #33)
 * @returns {Promise<Array>} results with file, title, heading, cosine, score,
 *   matches (query terms found in the chunk, issue #13), snippet
 */
export async function search(opts) {
  const { indexDir, ...rest } = opts;
  const loaded = loadIndex(indexDir);
  return searchIndex({ ...rest, loaded });
}

// @ts-check
/**
 * Hybrid semantic + lexical search over a prebuilt index.
 * Ranking = Reciprocal Rank Fusion of cosine similarity (meaning) and
 * term-overlap (exact names). The model is read from the index, so callers
 * never have to repeat --model at search time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { embed, cosine, resolveModel, decodeVec, isBinaryIndex, globToRegExp, walkMarkdown, SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './core.mjs';
import { rerankScores } from './rerank.mjs';

// Common ru/en function words — they match everywhere and pollute lexical scores.
// NOTE: content words (e.g. "код"/"кода" = "code") are deliberately NOT here —
// for an engineering wiki they carry real signal (issue #7).
//
// Issue #22: the old 3-char minimum ({3,}) silently dropped short identifiers
// (C#, C++, go, io, V8, d3, jq, ES7) from the lexical lane. Decision (recorded
// per #22 acceptance criteria): FLAT {2,} FLOOR + expanded STOP, not the
// identifier-only heuristic — the heuristic would still drop go/io/jq which are
// plain 2-letter words but real search terms. 2-letter noise is instead filtered
// by adding the common 2-letter EN/RU function words below. Single letters stay
// dropped (R/C are a deliberate miss — too noisy to keep).
const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'has', 'with', 'this', 'that', 'from',
  'not', 'but', 'you', 'your', 'can', 'all', 'any', 'its',
  'все', 'как', 'что', 'это', 'при', 'для', 'или', 'был', 'без', 'над',
  'под', 'так', 'его', 'нет', 'есть',
  // 2-letter EN function words (issue #22 — reachable with the {2,} floor).
  'of', 'to', 'in', 'on', 'it', 'is', 'at', 'by', 'be', 'we', 'us', 'he',
  'as', 'or', 'an', 'do', 'so', 'no', 'if', 'up', 'my', 'me', 'am',
  // 2-letter RU function words (issue #22).
  'по', 'от', 'из', 'на', 'за', 'во', 'со', 'не', 'ни', 'же', 'ли', 'бы',
  'уж', 'мы', 'вы', 'он', 'то', 'но', 'до', 'ко',
]);

/**
 * Tokenize for the LEXICAL lane (keywordScores/matches). The semantic lane
 * embeds full text, so these heuristics do not affect embeddings.
 *
 * Issue #22: tokens must START with a letter/digit, but may then contain
 * # + - INSIDE so identifier-like terms survive: "C#" → "c#", "C++" → "c++",
 * "win32-api" → "win32-api". Starting with a letter/digit means markdown noise
 * ("## heading", "---" rules, "+++") never becomes a token.
 * A trailing "." is a splitter (not in the class), so "end." → "end" and
 * "node.js" → "node" + "js" (both useful, and "e.g." → nothing).
 * Floor is 2 chars ({2,} via the {1,} class + length filter below); 1-char
 * tokens are pure noise and dropped. STOP filtering happens after.
 */
export function tokenize(text) {
  const m = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}#+-]*/gu);
  if (!m) return [];
  const out = [];
  for (const t of m) {
    if (t.length === 1) continue;
    if (!STOP.has(t)) out.push(t);
  }
  return out;
}

/**
 * Lexical scores by TOKEN OVERLAP (set intersection of query terms vs chunk
 * terms), not substring. "win" must NOT match "window", "token" must NOT match
 * "tokens" — only exact token overlap counts (issue #7). The haystack is
 * tokenized once per chunk with the same tokenize() as the query.
 * @returns {number[]} per-chunk count of overlapping unique terms
 */
export function keywordScores(chunks, query) {
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return chunks.map(() => 0);
  const hayTokens = chunks.map(c => new Set(tokenize(`${c.title} ${c.heading} ${c.text}`)));
  return chunks.map((c, i) => {
    let s = 0;
    for (const t of qTerms) if (hayTokens[i].has(t)) s++;
    return s;
  });
}

/** Reciprocal Rank Fusion. rankings: arrays of {idx, score}; higher = better. */
export function rrf(rankings, k = 60) {
  const fused = new Map();
  for (const ranking of rankings) {
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    sorted.forEach((item, rank) => {
      if (item.score <= 0) return;
      fused.set(item.idx, (fused.get(item.idx) || 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

/**
 * @typedef {Object} IndexChunk
 * @property {string} file
 * @property {string} title
 * @property {string} heading
 * @property {string} text
 * @property {number[]|Float32Array} vec
 * @property {string} [chunkHash]
 */

/**
 * @typedef {Object} IndexFile
 * @property {string} [format]
 * @property {string} [model]
 * @property {string} [modelAlias]
 * @property {number} [dim]
 * @property {string} [built]
 * @property {number} [chunkCount]
 * @property {string} [db] - markdown base the index was built from (issue #13 --since)
 * @property {IndexChunk[]} chunks
 */

/**
 * Parse + decode an index file once. Returns the raw index plus the resolved
 * model, so a library consumer can hold BOTH in memory across searches and
 * skip re-parsing vectors.json on every query (issue #2 / #14).
 * @param {string} indexDir
 * @returns {{index: IndexFile, model: import('./core.mjs').ModelDescriptor}}
 */
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
  if (newest <= builtMs) return;                   // fresh — nothing changed since build
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
  let index;
  try {
    index = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  } catch (e) {
    // Corrupt index file — name the file and the fix, no raw stack trace
    // (issue #20).
    throw new Error(
      `${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild.`);
  }

  // Schema gate (issue #39): an index written by a NEWER mdss must not be
  // misparsed by an older binary — clear upgrade error instead of silent
  // garbage. Older schemas are migrated step-by-step (v0 legacy shapes are
  // already handled by the format heuristics below).
  const schema = index.schemaVersion ?? 0;
  if (schema > SCHEMA_VERSION) {
    throw new Error(
      `${vectorsPath} uses schema v${schema}, but this mdss supports up to ` +
      `v${SCHEMA_VERSION} (built by a newer version) — upgrade md-semantic-search.`);
  }
  for (let v = schema + 1; v <= SCHEMA_VERSION; v++) {
    const step = SCHEMA_MIGRATIONS[v];
    if (step) step(index);
  }

  // Validate the model the index was built with. Indexes written by v0.1.x have
  // no "model" field at all — warn instead of silently assuming a default.
  if (!index.model && !index.modelAlias) {
    process.stderr.write('warning: index has no "model" field (built by an old ' +
      'version); assuming the default model. Re-run `mdss index` to refresh.\n');
  }

  const model = resolveModel(index.modelAlias || index.model);
  // Expected vector length for the dim check (issue #40): the stored index.dim
  // wins; legacy indexes without dim fall back to the resolved model's dim.
  const expectedDim = index.dim ?? (model.dim > 0 ? model.dim : undefined);

  // v0.4.0+ stores vectors as base64 Float32Array (issue #4); legacy ≤0.3.x
  // indexes hold decimal arrays. Decode the binary format once up front so the
  // cosine sweep below always sees plain numbers. Dim validation runs for BOTH
  // shapes (issue #40): a wrong-length vector — from a truncated base64, a
  // mixed-model index, or a partial write — used to silently produce NaN
  // scores; now it fails loudly at load with the chunk's identity.
  for (const c of index.chunks) {
    if (typeof c.vec === 'string') {
      if (!isBinaryIndex(index)) {
        throw new Error(`chunk ${c.file}: unexpected base64 vector in a legacy ` +
          `decimal index — run \`mdss index\` to rebuild`);
      }
      try {
        // decodeVec throws on corrupt base64 (truncated, non-finite, wrong dim)
        c.vec = decodeVec(c.vec, expectedDim);
      } catch (e) {
        const where = c.file + (c.heading ? ` › ${c.heading}` : '');
        throw new Error(`chunk ${where}: ${e.message}`);
      }
    } else if (expectedDim !== undefined && Array.isArray(c.vec) &&
               c.vec.length !== expectedDim) {
      const where = c.file + (c.heading ? ` › ${c.heading}` : '');
      throw new Error(`chunk ${where}: vector has ${c.vec.length} dims, ` +
        `expected ${expectedDim} — run \`mdss index\` to rebuild`);
    }
  }

  warnIfStale(index);

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
 * @returns {Promise<Array>} results with file, title, heading, cosine, score,
 *   matches (query terms found in the chunk, issue #13), snippet, and
 *   rerankScore when reranking was enabled (issue #15)
 */
export async function searchIndex(opts) {
  const {
    loaded, cacheDir, query, k = 6, semanticOnly = false,
    offline = false, path: pathFilter, since,
    rerank = false, rerankPool,
  } = opts;
  // `??` (not destructuring defaults): serve.mjs passes `embedFn: null` when
  // no override is given, and JS defaults only fire on `undefined` — using ??
  // here makes the real extractor/reranker the fallback for null AND undefined
  // (issue #23).
  const embedFn = opts.embedFn ?? embed;
  const rerankFn = opts.rerankFn ?? rerankScores;
  const { index, model } = loaded;

  // Candidate filtering happens BEFORE embedding/ranking (issue #13): --path
  // globs and --since (file mtime) shrink the sweep for large corpora.
  const pathRes = pathFilter
    ? (Array.isArray(pathFilter) ? pathFilter : [pathFilter]).map(globToRegExp)
    : [];
  let sinceMs;
  if (since !== undefined) {
    sinceMs = since instanceof Date ? since.getTime() : Date.parse(String(since));
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since date: "${since}" (use YYYY-MM-DD or ISO 8601)`);
  }
  let chunks = index.chunks;
  if (pathRes.length > 0 || sinceMs !== undefined) {
    if (sinceMs !== undefined && !index.db) {
      throw new Error('--since requires an index that knows its --db (index.db missing). Re-run `mdss index`.');
    }
    const mtimeCache = new Map();
    chunks = index.chunks.filter(c => {
      if (pathRes.length > 0 && !pathRes.some(re => re.test(c.file))) return false;
      if (sinceMs !== undefined) {
        let m = mtimeCache.get(c.file);
        if (m === undefined) {
          try { m = fs.statSync(path.join(index.db, c.file)).mtimeMs; }
          catch { m = -Infinity; } // file vanished → chunk no longer eligible
          mtimeCache.set(c.file, m);
        }
        if (m < sinceMs) return false;
      }
      return true;
    });
  }

  const [qVec] = await embedFn([query], 'query', model, cacheDir, offline);

  const semantic = chunks.map((c, idx) => ({ idx, score: cosine(qVec, c.vec) }));
  const cosByIdx = new Map(semantic.map(s => [s.idx, s.score]));

  // Candidate pool: without rerank we rank exactly k; with rerank we pull a
  // wider pool (default max(20, k*3)) and let the cross-encoder pick the best k.
  const pool = rerank ? (rerankPool || Math.max(20, k * 3)) : k;

  let ranked;
  if (semanticOnly) {
    ranked = [...semantic].sort((a, b) => b.score - a.score).slice(0, pool)
      .map(s => ({ idx: s.idx, fscore: s.score, cos: s.score }));
  } else {
    const kw = keywordScores(chunks, query).map((score, idx) => ({ idx, score }));
    const fused = rrf([semantic, kw]);
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

  const qTerms = new Set(tokenize(query));
  return ranked.map(r => {
    const c = chunks[r.idx];
    const hay = new Set(tokenize(`${c.title} ${c.heading} ${c.text}`));
    const matches = [...qTerms].filter(t => hay.has(t));
    return {
      file: c.file,
      title: c.title,
      heading: c.heading,
      cosine: +r.cos.toFixed(3),
      score: +r.fscore.toFixed(4),
      matches,
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 220),
      ...(rerank ? { rerankScore: +(r.rerank ?? 0).toFixed(4) } : {}),
    };
  });
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
 * @returns {Promise<Array>} results with file, title, heading, cosine, score,
 *   matches (query terms found in the chunk, issue #13), snippet
 */
export async function search(opts) {
  const { indexDir, ...rest } = opts;
  const loaded = loadIndex(indexDir);
  return searchIndex({ ...rest, loaded });
}

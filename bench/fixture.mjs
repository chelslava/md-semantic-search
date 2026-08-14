// @ts-check
/**
 * Versioned benchmark fixture FORMAT + validator (issue #56).
 *
 * A fixture is a single frozen JSON document describing a graded golden-set
 * benchmark: a frozen corpus plus a set of RU/EN queries with per-document
 * relevance grades (qrels). The runner consumes the normalized view returned
 * by {@link loadFixture}; the hand-curated golden set is authored to the exact
 * shape documented below and validated before any run.
 *
 * This module is intentionally standalone: it imports nothing from `src/`, so
 * it can be used by tooling, CI gates, and the runner alike.
 *
 * ## Fixture shape (JSON)
 * ```
 * {
 *   "schemaVersion": 1,
 *   "name": "string",
 *   "corpusPath": "string (absolute or repo-relative path to frozen .md corpus)",
 *   "corpusHash": "string (sha256 of frozen corpus; may be empty until computed)",
 *   "config": { "model": "...", "revision": "...", "quantization": "q8",
 *               "schema": 3, "chunker": "structural-v1" },
 *   "queries": [
 *     {
 *       "id": "q001",
 *       "language": "en" | "ru" | "ru-en" | "en-ru",
 *       "text": "the search query string",
 *       "category": "natural-question" | "keyword" | "identifier" |
 *                   "paraphrase" | "hierarchy" | "alias" | "broad" |
 *                   "relationship" | "hard-negative" | "other",
 *       "slice": "dev" | "test" | "holdout",
 *       "qrels": [ { "doc": "path/to/file.md", "grade": 0 | 1 | 2 | 3 } ]
 *     }
 *   ]
 * }
 * ```
 * - `grade`: 3 = direct answer, 2 = useful support, 1 = related, 0 = irrelevant.
 * - A query MUST have at least one qrel with `grade >= 1` (a positive qrel).
 * - A query id MUST NOT appear in more than one slice.
 */

import { createHash } from 'node:crypto';

/** The only supported fixture schema version. */
export const SCHEMA_VERSION = 1;

/** @type {ReadonlySet<string>} */
const LANGUAGES = new Set(['en', 'ru', 'ru-en', 'en-ru']);

/** @type {ReadonlySet<string>} */
const CATEGORIES = new Set([
  'natural-question', 'keyword', 'identifier', 'paraphrase', 'hierarchy',
  'alias', 'broad', 'relationship', 'hard-negative', 'other',
]);

/** Ordered slice names; also the key order of the returned `slices` view. */
const SLICES = ['dev', 'test', 'holdout'];

/** @type {ReadonlySet<string>} */
const SLICE_SET = new Set(SLICES);

/** Allowed qrel grades. 3=direct, 2=support, 1=related, 0=irrelevant. */
const GRADES = new Set([0, 1, 2, 3]);

/**
 * Validate a loaded fixture and return a deeply frozen, normalized view.
 *
 * On any malformed field it throws an Error describing exactly which path is
 * wrong (e.g. `queries[3].qrels[1].grade`). Validated constraints:
 * - `schemaVersion` must equal {@link SCHEMA_VERSION}.
 * - `name`, `corpusPath`, `corpusHash` are present (path/name nonempty).
 * - `config` is an object with a nonempty `config.model`.
 * - `queries` is an array; each entry has nonempty `id`/`text`, a known
 *   `language`/`category`/`slice`, and at least one positive (`grade >= 1`)
 *   qrel. Qrels have a nonempty `doc` and an integer `grade` in 0-3.
 * - Query ids are unique and no id appears in more than one slice.
 *
 * The normalized view is:
 * ```
 * { schemaVersion, name, corpusPath, corpusHash, config, queries,
 *   slices: { dev: string[], test: string[], holdout: string[] } }
 * ```
 * Each slice array holds the query ids assigned to it, in authoring order.
 *
 * @param {unknown} json
 * @returns {{
 *   schemaVersion: number; name: string; corpusPath: string; corpusHash: string;
 *   config: { model: string } & Record<string, unknown>;
 *   queries: Array<{ id: string; language: string; text: string;
 *     category: string; slice: string;
 *     qrels: Array<{ doc: string; grade: number }> }>;
 *   slices: { dev: string[]; test: string[]; holdout: string[] };
 * }}
 */
export function loadFixture(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('fixture root must be an object');
  }
  const f = /** @type {Record<string, unknown>} */ (json);

  if (f.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(f.schemaVersion)}`);
  }
  if (typeof f.name !== 'string' || f.name.trim().length === 0) {
    throw new Error('name must be a nonempty string');
  }
  if (typeof f.corpusPath !== 'string' || f.corpusPath.trim().length === 0) {
    throw new Error('corpusPath must be a nonempty string (absolute or repo-relative path to the frozen corpus)');
  }
  if (typeof f.corpusHash !== 'string') {
    throw new Error('corpusHash must be a string (may be empty until computed)');
  }
  const config = /** @type {unknown} */ (f.config);
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be an object');
  }
  const configObj = /** @type {Record<string, unknown>} */ (config);
  if (typeof configObj.model !== 'string' || configObj.model.trim().length === 0) {
    throw new Error('config.model must be a nonempty string');
  }

  if (!Array.isArray(f.queries)) {
    throw new Error('queries must be an array');
  }
  const queries = validateQueries(f.queries);

  const slices = buildSlices(queries);
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    name: f.name,
    corpusPath: f.corpusPath,
    corpusHash: f.corpusHash,
    config: { ...configObj },
    queries,
    slices,
  });
}

/**
 * @param {unknown[]} list
 * @returns {Array<{ id: string; language: string; text: string;
 *   category: string; slice: string;
 *   qrels: Array<{ doc: string; grade: number }> }>}
 */
function validateQueries(list) {
  /** @type {Map<string, string>} id -> slice, for dup / multi-slice detection */
  const sliceOwners = new Map();
  /** @type {Array<{ id: string; language: string; text: string;
   *   category: string; slice: string;
   *   qrels: Array<{ doc: string; grade: number }> }>} */
  const norm = [];
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const base = `queries[${i}]`;
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`${base} must be an object`);
    }
    const qr = /** @type {Record<string, unknown>} */ (q);

    if (typeof qr.id !== 'string' || qr.id.trim().length === 0) {
      throw new Error(`${base}.id must be a nonempty string`);
    }
    const prevSlice = sliceOwners.get(qr.id);
    if (prevSlice !== undefined) {
      if (prevSlice === qr.slice) {
        throw new Error(`${base}.id "${qr.id}" is a duplicate query id in slice "${qr.slice}"`);
      }
      throw new Error(`${base}.id "${qr.id}" appears in more than one slice (` +
        `${prevSlice} and ${qr.slice})`);
    }
    sliceOwners.set(qr.id, /** @type {string} */ (qr.slice));

    if (typeof qr.language !== 'string' || !LANGUAGES.has(qr.language)) {
      throw new Error(`${base}.language must be one of ${[...LANGUAGES].join(', ')}`);
    }
    if (typeof qr.text !== 'string' || qr.text.trim().length === 0) {
      throw new Error(`${base}.text must be a nonempty string`);
    }
    if (typeof qr.category !== 'string' || !CATEGORIES.has(qr.category)) {
      throw new Error(`${base}.category must be one of ${[...CATEGORIES].join(', ')}`);
    }
    if (typeof qr.slice !== 'string' || !SLICE_SET.has(qr.slice)) {
      throw new Error(`${base}.slice must be one of ${SLICES.join(', ')}`);
    }

    const qrels = validateQrels(qr.qrels, base);
    if (!qrels.some((r) => r.grade >= 1)) {
      throw new Error(`${base} must have at least one qrel with grade >= 1`);
    }
    norm.push({
      id: /** @type {string} */ (qr.id),
      language: /** @type {string} */ (qr.language),
      text: /** @type {string} */ (qr.text),
      category: /** @type {string} */ (qr.category),
      slice: /** @type {string} */ (qr.slice),
      qrels,
    });
  }
  return norm;
}

/**
 * @param {unknown} qrels
 * @param {string} base e.g. `queries[3]`
 * @returns {Array<{ doc: string; grade: number }>}
 */
function validateQrels(qrels, base) {
  if (!Array.isArray(qrels)) {
    throw new Error(`${base}.qrels must be an array`);
  }
  /** @type {Array<{ doc: string; grade: number }>} */
  const norm = [];
  /** @type {Set<string>} */
  const docs = new Set();
  for (let j = 0; j < qrels.length; j++) {
    const rel = qrels[j];
    const p = `${base}.qrels[${j}]`;
    if (rel === null || typeof rel !== 'object' || Array.isArray(rel)) {
      throw new Error(`${p} must be an object`);
    }
    const rr = /** @type {Record<string, unknown>} */ (rel);
    if (typeof rr.doc !== 'string' || rr.doc.trim().length === 0) {
      throw new Error(`${p}.doc must be a nonempty string`);
    }
    if (typeof rr.grade !== 'number' || !Number.isInteger(rr.grade) || !GRADES.has(rr.grade)) {
      throw new Error(`${p}.grade must be an integer in 0-3`);
    }
    if (docs.has(/** @type {string} */ (rr.doc))) {
      throw new Error(`${p}.doc "${rr.doc}" duplicates another qrel in this query`);
    }
    docs.add(/** @type {string} */ (rr.doc));
    norm.push({ doc: /** @type {string} */ (rr.doc), grade: rr.grade });
  }
  return norm;
}

/**
 * @param {Array<{ id: string; slice: string }>} queries
 * @returns {{ dev: string[]; test: string[]; holdout: string[] }}
 */
function buildSlices(queries) {
  /** @type {{ dev: string[]; test: string[]; holdout: string[] }} */
  const slices = { dev: [], test: [], holdout: [] };
  for (const q of queries) {
    slices[/** @type {'dev' | 'test' | 'holdout'} */ (q.slice)].push(q.id);
  }
  return slices;
}

/**
 * Recursively freeze an object graph, returning the top object.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Reflect.ownKeys(value)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      deepFreeze(/** @type {unknown} */ (value[/** @type {string | symbol} */ (key)]));
    }
  }
  return Object.freeze(value);
}

/**
 * Compute a stable sha256 fingerprint over a frozen corpus.
 *
 * Algorithm (deterministic and order-independent):
 * 1. For each input, derive a per-file hash:
 *    - if `content` is a string, hash its UTF-8 bytes with sha256;
 *    - else use the supplied `hash` string as-is.
 * 2. Sort entries by `path` (ascending, byte-wise stable order).
 * 3. Concatenate `path \0 hash \0` for every sorted entry and sha256 the whole
 *    buffer.
 *
 * The \0 separators make the encoding unambiguous (paths/hashes may contain
 * most printable characters). Duplicate paths and entries with neither content
 * nor a nonempty hash are rejected. Reordering the input array never changes
 * the result.
 *
 * @param {Array<{ path: string; content?: string; hash?: string }>} files
 * @returns {string} 64-char lowercase hex sha256.
 */
export function corpusFingerprint(files) {
  if (!Array.isArray(files)) {
    throw new Error('corpusFingerprint expects an array of {path, content} or {path, hash}');
  }
  /** @type {Array<{ path: string; hash: string }>} */
  const entries = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`corpusFingerprint: files[${i}] must be an object`);
    }
    const fr = /** @type {Record<string, unknown>} */ (f);
    if (typeof fr.path !== 'string' || fr.path.length === 0) {
      throw new Error(`corpusFingerprint: files[${i}].path must be a nonempty string`);
    }
    if (seen.has(/** @type {string} */ (fr.path))) {
      throw new Error(`corpusFingerprint: duplicate path "${fr.path}"`);
    }
    seen.add(/** @type {string} */ (fr.path));

    let hash;
    if (typeof fr.content === 'string') {
      hash = createHash('sha256').update(fr.content, 'utf8').digest('hex');
    } else if (typeof fr.hash === 'string' && fr.hash.length > 0) {
      hash = fr.hash;
    } else {
      throw new Error(`corpusFingerprint: files[${i}] requires a string content or a nonempty hash`);
    }
    entries.push({ path: /** @type {string} */ (fr.path), hash });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const h = createHash('sha256');
  for (const e of entries) {
    h.update(`${e.path}\u0000${e.hash}\u0000`);
  }
  return h.digest('hex');
}

/**
 * Deterministically group queries into dev/test/holdout slices.
 *
 * Algorithm:
 * 1. Group query ids by `category` first, so paraphrases / same-intent queries
 *    always stay together inside one slice.
 * 2. Within each category, sort ids ascending (stable regardless of input
 *    order) and partition sequentially:
 *    - dev takes the first `round(n * devRatio)` ids,
 *    - test takes the next `round(n * (devRatio + testRatio)) - nDev` ids,
 *    - the remainder goes to holdout.
 * 3. Concatenate each slice across categories in sorted-category order.
 *
 * Rounding is half-up (`Math.round`); cumulative rounding guarantees the three
 * slices always partition every category exactly with no overlap or loss, and
 * `devRatio + testRatio <= 1` keeps holdout non-negative. No randomness is
 * used, so identical input always yields identical output.
 *
 * @param {Array<{ id: string; category: string }>} queries
 * @param {{ devRatio?: number; testRatio?: number }} [options]
 * @returns {{ dev: string[]; test: string[]; holdout: string[] }}
 */
export function splitIntoSlices(queries, { devRatio = 0.7, testRatio = 0.15 } = {}) {
  if (!Array.isArray(queries)) {
    throw new Error('splitIntoSlices expects an array of query objects');
  }
  if (typeof devRatio !== 'number' || !Number.isFinite(devRatio) || devRatio < 0 || devRatio > 1) {
    throw new Error('devRatio must be a number in [0, 1]');
  }
  if (typeof testRatio !== 'number' || !Number.isFinite(testRatio) || testRatio < 0 || testRatio > 1) {
    throw new Error('testRatio must be a number in [0, 1]');
  }
  if (devRatio + testRatio > 1) {
    throw new Error('devRatio + testRatio must not exceed 1');
  }

  /** @type {Map<string, string[]>} category -> query ids */
  const groups = new Map();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`splitIntoSlices: queries[${i}] must be an object`);
    }
    const qr = /** @type {Record<string, unknown>} */ (q);
    if (typeof qr.id !== 'string' || qr.id.length === 0) {
      throw new Error(`splitIntoSlices: queries[${i}].id must be a nonempty string`);
    }
    if (typeof qr.category !== 'string' || qr.category.length === 0) {
      throw new Error(`splitIntoSlices: queries[${i}].category must be a nonempty string`);
    }
    const cat = /** @type {string} */ (qr.category);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(/** @type {string} */ (qr.id));
  }

  /** @type {string[]} */
  const dev = [];
  /** @type {string[]} */
  const test = [];
  /** @type {string[]} */
  const holdout = [];

  const cats = [...groups.keys()].sort();
  for (const cat of cats) {
    const ids = groups.get(cat).slice().sort();
    const n = ids.length;
    const nDev = Math.round(n * devRatio);
    const nTest = Math.round(n * (devRatio + testRatio)) - nDev;
    for (let k = 0; k < n; k++) {
      if (k < nDev) dev.push(ids[k]);
      else if (k < nDev + nTest) test.push(ids[k]);
      else holdout.push(ids[k]);
    }
  }
  return { dev, test, holdout };
}
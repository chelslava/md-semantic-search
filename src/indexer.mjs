// @ts-check
/**
 * Build / refresh the semantic index for a folder of markdown files.
 * Incremental at TWO levels:
 *   1. per-file md5  -> completely unchanged files reuse their chunks as-is;
 *   2. per-chunk hash (chunkHash = SHA-256 of the exact passage input that
 *      goes to embed()) -> inside a *changed* file, sections whose embedding
 *      input is unchanged reuse their stored vector, so an append/edit in one
 *      place of a long file no longer re-embeds all of its sections.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkMarkdown, parseFile, embed, resolveModel, decodeVec, encodeVec, SCHEMA_VERSION, SCHEMA_MIGRATIONS, withIndexLock, parseSchemaVersion, resolveIndexDimension } from './core.mjs';
import { validateIndexEnvelope, validateNumericVector } from './index-format.mjs';
import { analyzeLexicalDocument, buildLexicalIndex, lexicalIdentity, reverseLexicalIndex, validateLexicalIndex } from './lexical.mjs';
import { embeddingAdapterFingerprint, legacyEmbeddingAdapterFingerprint } from './models.mjs';

/**
 * @typedef {Object} IndexChunk
 * @property {string} file
 * @property {string} title
 * @property {string} heading
 * @property {string[]} headingPath
 * @property {string} text
 * @property {number[]|Float32Array} [vec]
 * @property {string} [chunkHash]
 */

/**
 * @typedef {Object} PersistedIndex
 * @property {number} [schemaVersion]
 * @property {string} [format]
 * @property {string|null} [model]
 * @property {string} [modelAlias]
 * @property {string} [adapterFingerprint]
 * @property {number} [dim]
 * @property {string} [db]
 * @property {string} [built]
 * @property {boolean} [complete]
 * @property {number} [chunkCount]
 * @property {Record<string,string>} [hashes]
 * @property {import('./lexical.mjs').LexicalIndex} [lexical]
 * @property {IndexChunk[]} chunks
 */

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const BATCH = 32;
const CHECKPOINT_BATCHES = 8;
const INDEX_FORMAT = 'binary-v1';

/** @param {unknown} value @returns {value is Record<string,string>} */
function isStringRecord(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string');
}

/**
 * Read JSON, falling back to `fb` when the file is missing or corrupt.
 * A corrupt-but-present file is reported through `warn` (default: silent) so a
 * torn write or manual edit doesn't silently wipe the previous index state.
/**
 * Read JSON, falling back to `fb` when the file is missing or corrupt.
 * A corrupt-but-present file is reported through `warn` (default: silent) so a
 * torn write or manual edit doesn't silently wipe the previous index state.
 * @template T
 * @param {string} p
 * @param {T} fb
 * @param {(msg:string)=>void} [warn]
 * @returns {T}
 */
const loadJSON = (p, fb, warn = () => {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      warn(`warning: ${path.basename(p)} is not valid JSON (${e.message}); ` +
           'rebuilding it from scratch.');
    }
    return fb;
  }
};

/**
 * Atomic write: dump to a temp file in the SAME directory, then rename over the
 * target. Rename is atomic on POSIX and on NTFS, so a crash mid-write can never
 * leave a truncated vectors.json that the next run would parse as "corrupt".
 */
function atomicWrite(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);

  if (path.basename(target) === 'vectors.json') {
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    const shaPath = `${target}.sha256`;
    const shaTmp = `${shaPath}.${process.pid}.tmp`;
    fs.writeFileSync(shaTmp, `${digest}  vectors.json\n`);
    fs.renameSync(shaTmp, shaPath);
  }
}

/** Normalize text for stable hashing across runs: CRLF -> LF, trim edges. */
function normalize(s) {
  return (s ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Serialize the one canonical full-context passage used for embedding and
 * chunk identity. The title-derived H1 is omitted from the path only when it
 * duplicates the normalized title.
 * @param {{title:string, heading:string, headingPath?:string[], text:string}} chunk
 */
export function canonicalPassage(chunk) {
  const title = normalize(chunk.title);
  const headingPath = (chunk.headingPath ?? (normalize(chunk.heading) ? [chunk.heading] : [])).map(normalize);
  const serializedPath = (headingPath[0] === title ? headingPath.slice(1) : headingPath).join(' > ');
  return [title, serializedPath, normalize(chunk.text)].join('\n');
}

/**
 * Stable per-chunk hash: SHA-256 over the exact passage input that is passed
 * to embed() plus the model identity and its passage
 * prefix. Because the model participates in the key, switching models
 * invalidates every chunk (full rebuild) - by design. CRLF/whitespace-only
 * edits of a section do NOT change its hash, so its vector is reused.
 *
 * The pinned revision (id@revision, default "main") is part of the key too, so
 * a @revision bump invalidates the vectors embedded by the old revision
 * (issue #27) - the README's "pinned ids invalidate the index" promise.
 *
 * NOTE: the CLI alias (e.g. "e5-base") is deliberately NOT part of the key —
 * only `model.id` + `revision` + `passagePrefix` determine embedding
 * semantics, so hashing is identical for alias and raw-id spellings (issue #6).
 * Adding `revision` to the key (0.5.0) changes stored hash values vs ≤0.4.x →
 * a one-time re-index of changed sections on upgrade.
 * @param {{id:string, revision?:string, passagePrefix?:string, pooling?:import('./models.mjs').Pooling}} model - resolved model descriptor
 * @param {{title:string, heading:string, headingPath?:string[], text:string}} chunk
 */
export function chunkHash(model, chunk) {
  const pooling = model.pooling ?? 'mean';
  const input = [
    pooling === 'mean' ? 'heading-path-v1' : `heading-path-v1:${pooling}`,
    model.id,
    model.revision || 'main',
    model.passagePrefix || '',
    canonicalPassage(chunk),
  ].join('\u0000');
  return sha256(input);
}

/**
 * @param {object} opts
 * @param {string} opts.db        - base dir of .md files (absolute)
 * @param {string} opts.indexDir  - where vectors.json / .hashes.json live
 * @param {string} opts.cacheDir  - model cache dir
 * @param {string} opts.modelName - model alias or id
 * @param {string[]} opts.ignore  - glob patterns to skip
 * @param {boolean} [opts.offline=false] - never download the model; require a cached one
 * @param {(s:string)=>void} [opts.log]
 * @param {Function} [opts.embedFn] - embed override for tests/dependency injection;
 *   signature (texts, kind, model, cacheDir, offline) => Promise<number[][]>
 * @param {boolean} [opts._lockHeld=false] - TESTING ONLY: caller already holds the
 *   index lock (we are the inner build). Skips re-acquisition — real callers must
 *   NOT set this (the lock IS the guard against concurrent writers, issue #37).
 * @param {number} [opts.maxRetries=3] - max retry attempts on transient network errors
 */
export async function buildIndex(opts) {
  const {
    db, indexDir, cacheDir, modelName, ignore = [], log = () => {},
    offline = false, embedFn = embed, _lockHeld = false, maxRetries = 3,
  } = opts;
  // Every write to vectors.json + .hashes.json runs under the index lock
  // (issue #37): the two atomic renames are individually atomic, but TWO
  // concurrent builds interleave and can leave the pair from different runs
  // (a torn logical state). The lock serializes writers; a second process gets
  // a clear "locked by PID …" error instead of corrupting the index.
  if (_lockHeld) return _buildIndexInner({ db, indexDir, cacheDir, modelName, ignore, log, offline, embedFn, maxRetries });
  return withIndexLock(indexDir, () =>
    _buildIndexInner({ db, indexDir, cacheDir, modelName, ignore, log, offline, embedFn, maxRetries }));
}

/**
 * The actual build; always runs under the index lock (see buildIndex).
 * Split out so the lock wrapper stays a one-liner.
 * @param {object} o
 * @param {string} o.db
 * @param {string} o.indexDir
 * @param {string} o.cacheDir
 * @param {string} o.modelName
 * @param {string[]} [o.ignore]
 * @param {(s:string)=>void} [o.log]
 * @param {boolean} [o.offline]
 * @param {Function} [o.embedFn]
 * @param {number} [o.maxRetries]
 */
async function _buildIndexInner({ db, indexDir, cacheDir, modelName, ignore = [], log = () => {}, offline = false, embedFn = embed, maxRetries = 3 }) {
  const model = resolveModel(modelName);
  // Model identity INCLUDES the pinned revision (issue #27): the README's
  // "pinned ids invalidate the index too (the revision is part of the model
  // key)" must hold. Default (unpinned) models resolve to revision "main", so
  // plain `--model e5-base` keeps the historical `model` value... except the
  // upgrade path: pre-0.5 indexes stored `model` WITHOUT `@main`, so they get
  // one full rebuild on upgrade (same migration the 0.4.0 chunkHash change did).
  const modelIdentity = `${model.id}@${model.revision || 'main'}`;
  const adapterFingerprint = embeddingAdapterFingerprint(model);
  const legacyAdapterFingerprint = legacyEmbeddingAdapterFingerprint(model);
  /** @param {PersistedIndex} index */
  const adapterCompatible = (index) => index.adapterFingerprint === adapterFingerprint ||
    (index.adapterFingerprint === undefined && adapterFingerprint === legacyAdapterFingerprint);
  const vectorsPath = path.join(indexDir, 'vectors.json');
  const hashesPath = path.join(indexDir, '.hashes.json');
  const checkpointPath = path.join(indexDir, '.checkpoint.json');

  fs.mkdirSync(indexDir, { recursive: true });

  const files = walkMarkdown(db, ignore);
  /** @type {Record<string,string>} */
  const canonicalHashes = loadJSON(hashesPath, {}, log);
  /** @type {PersistedIndex} */
  let canonicalIndex = loadJSON(vectorsPath, { chunks: [], model: null }, log);
  let canonicalSchema = 0;
  if (canonicalIndex !== null && typeof canonicalIndex === 'object' &&
      !Array.isArray(canonicalIndex)) {
    canonicalSchema = parseSchemaVersion(canonicalIndex.schemaVersion);
    if (canonicalSchema > SCHEMA_VERSION) {
      throw new Error(
        `${vectorsPath} uses schema v${canonicalSchema}, but this mdss writes ` +
        `v${SCHEMA_VERSION} (index built by a newer version) — upgrade ` +
        `md-semantic-search before re-indexing.`);
    }
  }
  if (canonicalIndex === null || typeof canonicalIndex !== 'object' ||
      !Array.isArray(canonicalIndex.chunks)) {
    log('warning: vectors.json root/chunks are invalid; rebuilding it from scratch.');
    canonicalIndex = { chunks: [], model: null };
    canonicalSchema = 0;
  }
  if (canonicalSchema === SCHEMA_VERSION) {
    try {
      validateIndexEnvelope(canonicalIndex, vectorsPath, {
        encoding: 'stored', validateVectors: false, validateLexical: false,
      });
    } catch (error) {
      log(`warning: ${error.message}; rebuilding vectors.json from scratch.`);
      canonicalIndex = { chunks: [], model: null };
    }
  }

  /** @type {PersistedIndex|null} */
  const checkpoint = loadJSON(checkpointPath, null, log);
  let checkpointEnvelopeValid = false;
  try {
    if (checkpoint !== null) {
      validateIndexEnvelope(checkpoint, checkpointPath, {
        encoding: 'stored', allowMissingVectors: true,
      });
      checkpointEnvelopeValid = true;
    }
  } catch {
    checkpointEnvelopeValid = false;
  }
  const checkpointCompatible = checkpoint !== null &&
    checkpointEnvelopeValid &&
    checkpoint.schemaVersion === SCHEMA_VERSION &&
    checkpoint.format === INDEX_FORMAT &&
    checkpoint.model === modelIdentity &&
    adapterCompatible(checkpoint) &&
    checkpoint.db === db &&
    typeof checkpoint.modelAlias === 'string' &&
    typeof checkpoint.built === 'string' &&
    typeof checkpoint.complete === 'boolean' &&
    Number.isInteger(checkpoint.chunkCount) &&
    Array.isArray(checkpoint.chunks) &&
    checkpoint.chunkCount === checkpoint.chunks.length &&
    (!checkpoint.complete || checkpoint.chunks.every(chunk => chunk.vec !== undefined)) &&
    isStringRecord(checkpoint.hashes) &&
    validateLexicalIndex(checkpoint.lexical, checkpoint.chunks.length) === null;
  const oldHashes = checkpointCompatible ? checkpoint.hashes : canonicalHashes;
  const oldIndex = checkpointCompatible ? checkpoint : canonicalIndex;

  // Older schemas are migrated via the table (v0 → v1 is a no-op: the legacy
  // shapes are normalized by the heuristics right below).
  const sourceSchema = parseSchemaVersion(oldIndex.schemaVersion);
  for (let v = sourceSchema + 1; v <= SCHEMA_VERSION; v++) {
    const step = SCHEMA_MIGRATIONS[v];
    if (step) step(oldIndex);
  }

  // v0.4.0+ stores vectors as base64 Float32Array (issue #4); legacy ≤0.3.x
  // indexes hold decimal arrays. Normalize the old format to plain arrays so
  // the chunk-level reuse path (vecByChunkHash) sees numbers either way.
  const oldModel = resolveModel(oldIndex.model || oldIndex.modelAlias);
  let oldExpectedDim;
  let oldDimensionValid = true;
  try {
    oldExpectedDim = resolveIndexDimension(oldIndex.dim, oldModel.dim);
  } catch (error) {
    oldDimensionValid = false;
    log(`warning: ${error.message}; stored vectors will be rebuilt.`);
  }
  for (const c of oldIndex.chunks) {
    if (typeof c.vec === 'string' && oldIndex.format === 'binary-v1') {
      try {
        c.vec = oldDimensionValid ? decodeVec(c.vec, oldExpectedDim) : undefined;
      } catch (e) {
        // A corrupt vector in the OLD index must not abort the re-index: drop
        // it (vec stays undefined → the file-level fast path re-embeds it, see
        // the vec-less chunk handling below) and warn (issue #40).
        log(`warning: dropping corrupt vector for ${c.file}` +
          (c.heading ? ` › ${c.heading}` : '') + ` (${e.message})`);
        c.vec = undefined;
      }
    } else if (c.vec !== undefined) {
      try {
        if (!oldDimensionValid) throw new Error('invalid stored dimension');
        validateNumericVector(c.vec, oldExpectedDim, `chunk ${c.file}`);
      } catch {
        log(`warning: dropping corrupt vector for ${c.file}` +
          (c.heading ? ` › ${c.heading}` : ''));
        c.vec = undefined;
      }
    }
  }

  // If the model (id OR pinned revision) changed, all stored vectors are
  // incompatible → full rebuild (issue #27: a @revision bump must invalidate).
  const modelChanged = oldIndex.model && oldIndex.model !== modelIdentity;
  const contextVectorsReusable = sourceSchema >= 2 && !modelChanged && adapterCompatible(oldIndex);
  let buildDim = model.dim > 0 ? model.dim :
    (contextVectorsReusable && oldDimensionValid ? oldExpectedDim : undefined);
  /** @param {unknown} vector */
  const acceptBuildVector = (vector) => {
    const length = validateNumericVector(vector, buildDim, 'embedding vector');
    buildDim ??= length;
  };
  /** @param {unknown} vector */
  const reusableVector = (vector) => {
    try {
      acceptBuildVector(vector);
      return true;
    } catch {
      return false;
    }
  };

  const lexicalReusable = sourceSchema === 3 &&
    validateLexicalIndex(oldIndex.lexical, oldIndex.chunks.length) === null &&
    oldIndex.lexical.format === 'bm25-v2';
  const oldLexicalRecords = lexicalReusable ? reverseLexicalIndex(oldIndex.lexical) : [];

  const oldByFile = new Map();
  // chunk-level cache: hash of the passage input -> stored vector. Built from
  // the OLD index so changed files can reuse vectors of unchanged sections.
  // Missing hashes are recomputed only for schema-v2 chunks. Earlier schemas
  // predate contextual passages and must never seed either reuse path.
  const vecByChunkHash = new Map();
  const lexicalByFile = new Map();
  const lexicalByIdentity = new Map();
  for (let oldDocId = 0; oldDocId < oldIndex.chunks.length; oldDocId++) {
    const c = oldIndex.chunks[oldDocId];
    const lexicalRecord = oldLexicalRecords[oldDocId];
    if (contextVectorsReusable) {
      if (!oldByFile.has(c.file)) oldByFile.set(c.file, []);
      oldByFile.get(c.file).push(c);
      const key = c.chunkHash || chunkHash(model, c);
      if (c.vec) vecByChunkHash.set(key, c.vec);
    }
    if (lexicalRecord) {
      if (!lexicalByFile.has(c.file)) lexicalByFile.set(c.file, []);
      lexicalByFile.get(c.file).push(lexicalRecord);
      lexicalByIdentity.set(lexicalIdentity(c), lexicalRecord);
    }
  }

  const newHashes = {};
  const chunks = [];
  const lexicalRecords = [];
  const toEmbed = [];
  let reused = 0, reusedChunks = 0, changedFiles = 0, skipped = 0;

  /** @param {IndexChunk} chunk @param {import('./lexical.mjs').TermFrequencies} [record] */
  const appendChunk = (chunk, record) => {
    chunks.push(chunk);
    lexicalRecords.push(record ?? analyzeLexicalDocument(chunk));
  };

  /**
   * Serialize all current chunks for crash recovery. Unfinished chunks omit
   * `vec`; the existing vec-less reuse path requeues them on the next run.
   * @param {boolean} complete
   */
  const checkpointSnapshot = (complete) => ({
    schemaVersion: SCHEMA_VERSION,
    format: INDEX_FORMAT,
model: modelIdentity,
    modelAlias: typeof modelName === 'string' ? (modelName || 'e5-base') : model.id,
    adapterFingerprint,
    ...(buildDim === undefined ? {} : { dim: buildDim }),
    db,
    built: new Date().toISOString(),
    complete,
    chunkCount: chunks.length,
    hashes: newHashes,
    lexical: buildLexicalIndex(lexicalRecords),
    chunks: chunks.map(c => ({ ...c, vec: c.vec ? encodeVec(c.vec) : undefined })),
  });

  for (const abs of files) {
    const rel = path.relative(db, abs).split(path.sep).join('/');
    /** @type {IndexChunk[]} */
    let parsed;
    let reusableLexicalRecords;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const h = md5(raw);
      newHashes[rel] = h;
      if (oldHashes[rel] === h) reusableLexicalRecords = lexicalByFile.get(rel);

      if (sourceSchema === SCHEMA_VERSION && contextVectorsReusable &&
          oldHashes[rel] === h && oldByFile.has(rel)) {
        const old = oldByFile.get(rel);
        // Backfill chunkHash for chunks that predate the chunk-level cache, so
        // the persisted index is self-contained and no recompute is needed later.
        for (const c of old) {
          if (!c.chunkHash) c.chunkHash = chunkHash(model, c);
        }
        for (let oldPosition = 0; oldPosition < old.length; oldPosition++) {
          const c = old[oldPosition];
          if (c.vec && reusableVector(c.vec)) {
            appendChunk(c, reusableLexicalRecords?.[oldPosition]);
            reused++;
          } else {
            // Vec-less chunk (legacy index or a corrupt write): reusing it as-is
            // would persist a broken index that crashes every search with
            // `cosine(qVec, c.vec)` on undefined. Re-embed it instead (issue #25).
            c.vec = undefined;
            toEmbed.push(c);
            appendChunk(c, reusableLexicalRecords?.[oldPosition]);
          }
        }
        continue;
      }
      changedFiles++;
      // Pass the already-read content so the file is NOT read a second time
      // (issue #35: changed files were being read twice — once for the md5
      // fast-path check, once inside parseFile).
      parsed = parseFile(abs, db, undefined, raw);
    } catch (e) {
      // One unreadable file (EACCES, EISDIR after a race, a broken symlink)
      // must not abort the whole run: skip it with a warning and keep going
      // (issue #36). The file stays out of newHashes AND out of the index, so
      // its old chunks drop exactly like a deleted file's do — and it is
      // retried (and re-warned) on the next run once it becomes readable again.
      delete newHashes[rel];
      skipped++;
      log(`warning: skipping ${rel} (${e.code || e.message})`);
      continue;
    }
    for (let parsedPosition = 0; parsedPosition < parsed.length; parsedPosition++) {
      const c = parsed[parsedPosition];
      const key = chunkHash(model, c);
      const cached = vecByChunkHash.get(key);
      if (cached && reusableVector(cached)) {
        c.vec = cached;
        c.chunkHash = key;
        reused++;
        reusedChunks++;
      } else {
        c.chunkHash = key;
        toEmbed.push(c);
      }
      appendChunk(c, reusableLexicalRecords?.[parsedPosition] ??
        lexicalByIdentity.get(lexicalIdentity(c)));
    }
  }

  if (toEmbed.length > 0) {
    log(`Embedding ${toEmbed.length} chunks from ${changedFiles} changed file(s) ` +
        `with ${model.id}...`);
    let completedBatches = 0;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const slice = toEmbed.slice(i, i + BATCH);
      const vecs = await embedFn(
        slice.map(canonicalPassage),
        'passage', model, cacheDir, offline, { maxRetries, log },
      );
      let batchDim = buildDim;
      try {
        if (!Array.isArray(vecs) || vecs.length !== slice.length) throw new Error('batch size');
        if (vecs.length > 0 && batchDim === undefined) {
          batchDim = validateNumericVector(vecs[0], undefined, 'embedding vector 0');
        }
        for (const vec of vecs) validateNumericVector(vec, batchDim, 'embedding vector');
      } catch {
        throw new Error(`embedding returned invalid vectors` +
          (batchDim === undefined ? '' : ` (expected ${batchDim} dims)`) +
          ' — run `mdss index` to rebuild');
      }
      buildDim = batchDim;
      slice.forEach((c, j) => { c.vec = vecs[j]; });
      completedBatches++;
      if (completedBatches % CHECKPOINT_BATCHES === 0) {
        atomicWrite(checkpointPath, JSON.stringify(checkpointSnapshot(false)));
      }
      log(`  ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`);
    }
  }

  if (chunks.some(c => !c.vec)) {
    throw new Error('Embedding finished without a vector for every chunk.');
  }
  for (const chunk of chunks) acceptBuildVector(chunk.vec);
  const dim = buildDim ?? (model.dim > 0 ? model.dim : undefined);
  resolveIndexDimension(dim, model.dim);
  const index = {
    schemaVersion: SCHEMA_VERSION, // format gate (issue #39) — bump + add a migration step on change
format: INDEX_FORMAT,          // vec stored as base64 Float32Array (issue #4)
    model: modelIdentity,          // id@revision — revision is part of the key (#27)
    modelAlias: typeof modelName === 'string' ? (modelName || 'e5-base') : model.id,
    adapterFingerprint,
    ...(dim === undefined ? {} : { dim }),
    db,
    built: new Date().toISOString(),
    chunkCount: chunks.length,
    lexical: buildLexicalIndex(lexicalRecords),
    // ~4× smaller on disk than decimal JSON: 768-dim float = 3072 B → 4096 B
    // base64, vs ~8-10 chars per number for decimal.
    chunks: chunks.map(c => ({ ...c, vec: c.vec ? encodeVec(c.vec) : undefined })),
  };

  validateIndexEnvelope(index, 'generated index', { encoding: 'stored' });

  atomicWrite(checkpointPath, JSON.stringify({ ...index, complete: true, hashes: newHashes }));
  atomicWrite(vectorsPath, JSON.stringify(index));
  atomicWrite(hashesPath, JSON.stringify(newHashes, null, 2));
  fs.unlinkSync(checkpointPath);

  return {
    files: files.length,
    skipped,
    chunks: chunks.length,
    reused,
    reusedChunks,
    reusedFiles: reused - reusedChunks, // via the file-level fast path
    embedded: toEmbed.length,
    dim: dim ?? 0,
    model: model.id,
    vectorsPath,
  };
}

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
import {
  walkMarkdown,
  parseFile,
  embed,
  resolveModel,
  decodeVec,
  encodeVec,
  SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  withIndexLock,
  parseSchemaVersion,
  resolveIndexDimension,
  ModelAdapter,
} from './core.js';
import { validateIndexEnvelope, validateNumericVector } from './index-format.js';
import {
  analyzeLexicalDocument,
  buildLexicalIndex,
  lexicalIdentity,
  reverseLexicalIndex,
  validateLexicalIndex,
  LexicalIndex,
  TermFrequencies,
} from './lexical.js';
import { embeddingAdapterFingerprint, legacyEmbeddingAdapterFingerprint } from './models.js';
import { trainIVF, serializeIVF, ANN_THRESHOLD } from './ivf.js';
import { buildHnsw, serializeHnsw, HnswIndex } from './hnsw.js';
import { DocumentMetadata } from './frontmatter.js';
import { serializeBinaryIndex } from './binary-format.js';
import { defaultChunkTokenBudget } from './markdown-parser.js';

export interface IndexChunk {
  file: string;
  title: string;
  heading: string;
  headingPath: string[];
  text: string;
  vec?: number[] | Float32Array | string;
  chunkHash?: string;
  startLine?: number;
  endLine?: number;
  meta?: DocumentMetadata;
}

export interface PersistedIndex {
  schemaVersion?: number;
  format?: string;
  model?: string | null;
  modelAlias?: string;
  adapterFingerprint?: string;
  /**
   * issue #202: the effective chunk token budget these chunks were built
   * with (null = legacy char budget). A mismatch forces a full re-chunk —
   * otherwise the file-level fast path would keep stale char-budget chunks
   * for unchanged files and produce a mixed index. Identical chunk texts
   * still reuse their cached vectors through chunkHash.
   */
  chunkBudget?: number | null;
  dim?: number;
  db?: string;
  built?: string;
  complete?: boolean;
  chunkCount?: number;
  hashes?: Record<string, string>;
  lexical?: LexicalIndex;
  lexicalFormat?: string;
  chunks: IndexChunk[];
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export const _stats = {
  chunkHits: 0,
  fileHits: 0,
  embedCount: 0,
};

// issue #194: batch size is tunable — 64-128 often feeds ONNX noticeably
// better on short passages; overridable for experiments (clamped 1..512).
const BATCH = (() => {
  const raw = parseInt(process.env.MDSS_BATCH || '', 10);
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 512) : 32;
})();
// issue #194: mid-run checkpoints serialize the WHOLE index so far — with
// faster embedding that cost scales up. Time-budget them (~every 30 s) in
// addition to the batch cadence, so at most ~30 s of embedding is lost on a
// crash while serialization stays a small slice of wall time.
const CHECKPOINT_MIN_INTERVAL_MS = 30_000;
const CHECKPOINT_BATCHES = 8;
const INDEX_FORMAT = 'binary-v1';

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as object).every((entry) => typeof entry === 'string')
  );
}

const loadJSON = <T>(p: string, fb: T, warn: (msg: string) => void = () => {}): T => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      warn(`warning: ${path.basename(p)} is not valid JSON (${e.message}); rebuilding it from scratch.`);
    }
    return fb;
  }
};

function atomicWrite(target: string, data: string | Buffer): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);

  const base = path.basename(target);
  if (base === 'vectors.json' || base === 'vectors.bin') {
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    const shaPath = `${target}.sha256`;
    const shaTmp = `${shaPath}.${process.pid}.tmp`;
    fs.writeFileSync(shaTmp, `${digest}  ${base}\n`);
    fs.renameSync(shaTmp, shaPath);
  }
}

function normalize(s?: string): string {
  return (s ?? '').replace(/\r\n?/g, '\n').trim();
}

export function canonicalPassage(chunk: {
  title: string;
  heading: string;
  headingPath?: string[];
  text: string;
  meta?: DocumentMetadata;
}): string {
  const title = normalize(chunk.title);
  const headingPath = (chunk.headingPath ?? (normalize(chunk.heading) ? [chunk.heading] : [])).map(normalize);
  const serializedPath = (headingPath[0] === title ? headingPath.slice(1) : headingPath).join(' > ');
  const tagsStr = chunk.meta?.tags && chunk.meta.tags.length > 0 ? `tags: ${chunk.meta.tags.map(t => `#${t}`).join(' ')}` : '';
  const parts = [title, serializedPath, tagsStr, normalize(chunk.text)].filter(Boolean);
  return parts.join('\n');
}

export function chunkHash(
  model: { id: string; revision?: string; passagePrefix?: string; pooling?: string },
  chunk: { title: string; heading: string; headingPath?: string[]; text: string; meta?: DocumentMetadata }
): string {
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

export interface BuildIndexOptions {
  db: string;
  indexDir: string;
  cacheDir: string;
  modelName: string;
  dimensions?: number;
  ignore?: string[];
  offline?: boolean;
  log?: (s: string) => void;
  embedFn?: any;
  _lockHeld?: boolean;
  maxRetries?: number;
  onProgress?: (done: number, total: number, chunksPerSec: number) => void;
  workers?: number;
  /** issue #201: ANN sidecar engine — `true`/`'ivf'` = ivf.json, `'hnsw'` = hnsw.json. */
  ann?: boolean | 'ivf' | 'hnsw';
  quantize?: 'fp32' | 'int8';
  /**
   * issue #202: chunk budget in TOKENS (overrides the legacy char budget).
   * Default: min(adapter.maxTokens, 512) — the point of the issue is that the
   * char budget overflowed real maxTokens for Cyrillic. Explicit `0` restores
   * the legacy char behavior.
   */
  maxChunkTokens?: number;
}

export interface BuildIndexResult {
  files: number;
  skipped: number;
  chunks: number;
  reused: number;
  reusedChunks: number;
  reusedFiles: number;
  embedded: number;
  dim: number;
  model: string;
  vectorsPath: string;
}

export async function buildIndex(opts: BuildIndexOptions): Promise<BuildIndexResult> {
  const {
    db,
    indexDir,
    cacheDir,
    modelName,
    dimensions,
    ignore = [],
    log = () => {},
    offline = false,
    embedFn = embed,
    _lockHeld = false,
    maxRetries = 3,
    onProgress,
    workers = 1,
    ann = false,
    quantize = 'fp32',
    maxChunkTokens,
  } = opts;
  if (_lockHeld)
    return _buildIndexInner({ db, indexDir, cacheDir, modelName, dimensions, ignore, log, offline, embedFn, maxRetries, onProgress, workers, ann, quantize, maxChunkTokens });
  return withIndexLock(indexDir, () =>
    _buildIndexInner({ db, indexDir, cacheDir, modelName, dimensions, ignore, log, offline, embedFn, maxRetries, onProgress, workers, ann, quantize, maxChunkTokens })
  );
}

async function _buildIndexInner({
  db,
  indexDir,
  cacheDir,
  modelName,
  dimensions,
  ignore = [],
  log = () => {},
  offline = false,
  embedFn = embed,
  maxRetries = 3,
  onProgress,
  workers = 1,
  ann = false,
  quantize = 'fp32',
  maxChunkTokens = undefined,
}: Required<Omit<BuildIndexOptions, '_lockHeld' | 'onProgress' | 'workers' | 'ann' | 'quantize' | 'dimensions' | 'maxChunkTokens'>> & {
  dimensions?: number;
  onProgress?: (done: number, total: number, chunksPerSec: number) => void;
  workers?: number;
  ann?: boolean | 'ivf' | 'hnsw';
  quantize?: 'fp32' | 'int8';
  maxChunkTokens?: number;
}): Promise<BuildIndexResult> {
  const model = resolveModel(modelName, dimensions);
  // issue #202: explicit maxChunkTokens wins; `0` restores the legacy char
  // budget; otherwise min(adapter.maxTokens, 512), undefined → char mode
  const effectiveChunkTokens =
    maxChunkTokens === 0
      ? undefined
      : maxChunkTokens && maxChunkTokens > 0
        ? maxChunkTokens
        : defaultChunkTokenBudget(model);
  const modelIdentity = `${model.id}@${model.revision || 'main'}`;
  const adapterFingerprint = embeddingAdapterFingerprint(model);
  const legacyAdapterFingerprint = legacyEmbeddingAdapterFingerprint(model);
  const adapterCompatible = (index: PersistedIndex) =>
    index.adapterFingerprint === adapterFingerprint ||
    (index.adapterFingerprint === undefined && adapterFingerprint === legacyAdapterFingerprint);
  const vectorsPath = path.join(indexDir, 'vectors.json');
  const hashesPath = path.join(indexDir, '.hashes.json');
  const checkpointPath = path.join(indexDir, '.checkpoint.json');
  let lastCheckpointAt = 0;

  fs.mkdirSync(indexDir, { recursive: true });

  // issue #189: unreadable directories shrink the corpus — collect and log
  // them so a "shrinking" index is never published silently
  const walkErrors: string[] = [];
  const files = walkMarkdown(db, ignore, walkErrors);
  for (const we of walkErrors) log(we);
  const canonicalHashes = loadJSON<Record<string, string>>(hashesPath, {}, log);
  let canonicalIndex = loadJSON<PersistedIndex>(vectorsPath, { chunks: [] }, log);
  let canonicalSchema = 0;
  if (canonicalIndex !== null && typeof canonicalIndex === 'object' && !Array.isArray(canonicalIndex)) {
    canonicalSchema = parseSchemaVersion(canonicalIndex.schemaVersion);
    if (canonicalSchema > SCHEMA_VERSION) {
      throw new Error(
        `${vectorsPath} uses schema v${canonicalSchema}, but this mdss writes v${SCHEMA_VERSION} — upgrade md-semantic-search before re-indexing.`
      );
    }
  }
  if (canonicalIndex === null || typeof canonicalIndex !== 'object' || !Array.isArray(canonicalIndex.chunks)) {
    log('warning: vectors.json root/chunks are invalid; rebuilding it from scratch.');
    canonicalIndex = { chunks: [], model: null };
  }
  if (canonicalSchema === SCHEMA_VERSION) {
    try {
      validateIndexEnvelope(canonicalIndex, vectorsPath, {
        encoding: 'stored',
        validateVectors: false,
        validateLexical: false,
      });
    } catch (error: any) {
      log(`warning: ${error.message}; rebuilding vectors.json from scratch.`);
      canonicalIndex = { chunks: [], model: null };
    }
  }

  const checkpoint = loadJSON<PersistedIndex | null>(checkpointPath, null, log);
  let checkpointEnvelopeValid = false;
  try {
    if (checkpoint !== null) {
      validateIndexEnvelope(checkpoint, checkpointPath, {
        encoding: 'stored',
        allowMissingVectors: true,
      });
      checkpointEnvelopeValid = true;
    }
  } catch {
    checkpointEnvelopeValid = false;
  }
  const checkpointCompatible =
    checkpoint !== null &&
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
    (!checkpoint.complete || checkpoint.chunks.every((chunk) => chunk.vec !== undefined)) &&
    isStringRecord(checkpoint.hashes) &&
    validateLexicalIndex(checkpoint.lexical, checkpoint.chunks.length) === null;

  const oldHashes = checkpointCompatible ? checkpoint!.hashes! : canonicalHashes;
  const oldIndex = checkpointCompatible ? checkpoint! : canonicalIndex;

  const sourceSchema = parseSchemaVersion(oldIndex.schemaVersion);
  for (let v = sourceSchema + 1; v <= SCHEMA_VERSION; v++) {
    const step = SCHEMA_MIGRATIONS[v];
    if (step) step(oldIndex);
  }

  const oldModel = resolveModel(oldIndex.model || oldIndex.modelAlias);
  let oldExpectedDim: number | undefined;
  let oldDimensionValid = true;
  try {
    oldExpectedDim = resolveIndexDimension(oldIndex.dim, oldModel.dim);
  } catch (error: any) {
    oldDimensionValid = false;
    log(`warning: ${error.message}; stored vectors will be rebuilt.`);
  }
  for (const c of oldIndex.chunks) {
    if (typeof c.vec === 'string' && oldIndex.format === 'binary-v1') {
      try {
        c.vec = oldDimensionValid ? decodeVec(c.vec, oldExpectedDim) : undefined;
      } catch (e: any) {
        log(`warning: dropping corrupt vector for ${c.file}` + (c.heading ? ` › ${c.heading}` : '') + ` (${e.message})`);
        c.vec = undefined;
      }
    } else if (c.vec !== undefined) {
      try {
        if (!oldDimensionValid) throw new Error('invalid stored dimension');
        validateNumericVector(c.vec, oldExpectedDim, `chunk ${c.file}`);
      } catch {
        log(`warning: dropping corrupt vector for ${c.file}` + (c.heading ? ` › ${c.heading}` : ''));
        c.vec = undefined;
      }
    }
  }

  const modelChanged = !!oldIndex.model && oldIndex.model !== modelIdentity;
  const contextVectorsReusable = sourceSchema >= 2 && !modelChanged && adapterCompatible(oldIndex);
  // issue #202: a different chunk budget invalidates the file-level fast path
  // (unchanged files must be re-chunked), NOT the per-chunk vector cache —
  // chunks whose text did not move across the budget boundary re-embed free.
  const chunkBudgetMarker = effectiveChunkTokens ?? null;
  const chunkerChanged = (oldIndex.chunkBudget ?? null) !== chunkBudgetMarker;
  if (chunkerChanged && oldIndex.chunks.length > 0) {
    log('chunk budget changed — re-chunking all files (per-chunk vector cache still applies).');
  }
  let buildDim = model.dim > 0 ? model.dim : contextVectorsReusable && oldDimensionValid ? oldExpectedDim : undefined;
  const acceptBuildVector = (vector: unknown) => {
    const length = validateNumericVector(vector, buildDim, 'embedding vector');
    buildDim ??= length;
  };
  const reusableVector = (vector: unknown) => {
    try {
      acceptBuildVector(vector);
      return true;
    } catch {
      return false;
    }
  };

  const lexicalReusable =
    sourceSchema === 3 &&
    oldIndex.lexical &&
    validateLexicalIndex(oldIndex.lexical, oldIndex.chunks.length) === null &&
    oldIndex.lexical.format === 'bm25-v2';
  const oldLexicalRecords = lexicalReusable && oldIndex.lexical ? reverseLexicalIndex(oldIndex.lexical) : [];

  const oldByFile = new Map<string, IndexChunk[]>();
  const vecByChunkHash = new Map<string, any>();
  const lexicalByFile = new Map<string, TermFrequencies[]>();
  const lexicalByIdentity = new Map<string, TermFrequencies>();
  for (let oldDocId = 0; oldDocId < oldIndex.chunks.length; oldDocId++) {
    const c = oldIndex.chunks[oldDocId];
    const lexicalRecord = oldLexicalRecords[oldDocId];
    if (contextVectorsReusable) {
      if (!oldByFile.has(c.file)) oldByFile.set(c.file, []);
      oldByFile.get(c.file)!.push(c);
      const key = c.chunkHash || chunkHash(model, c);
      if (c.vec) vecByChunkHash.set(key, c.vec);
    }
    if (lexicalRecord) {
      if (!lexicalByFile.has(c.file)) lexicalByFile.set(c.file, []);
      lexicalByFile.get(c.file)!.push(lexicalRecord);
      lexicalByIdentity.set(lexicalIdentity(c), lexicalRecord);
    }
  }

  const newHashes: Record<string, string> = {};
  const chunks: IndexChunk[] = [];
  const lexicalRecords: TermFrequencies[] = [];
  const toEmbed: IndexChunk[] = [];
  let reused = 0,
    reusedChunks = 0,
    changedFiles = 0,
    skipped = 0;

  const appendChunk = (chunk: IndexChunk, record?: TermFrequencies) => {
    chunks.push(chunk);
    lexicalRecords.push(record ?? analyzeLexicalDocument(chunk));
  };

  const checkpointSnapshot = (complete: boolean) => ({
    schemaVersion: SCHEMA_VERSION,
    format: INDEX_FORMAT,
    model: modelIdentity,
    modelAlias: typeof modelName === 'string' ? modelName || 'e5-base' : model.id,
    adapterFingerprint,
    chunkBudget: chunkBudgetMarker,
    ...(buildDim === undefined ? {} : { dim: buildDim }),
    db,
    built: new Date().toISOString(),
    complete,
    chunkCount: chunks.length,
    hashes: newHashes,
    lexical: buildLexicalIndex(lexicalRecords),
    chunks: chunks.map((c) => ({ ...c, vec: c.vec ? (typeof c.vec === 'string' ? c.vec : encodeVec(c.vec)) : undefined })),
  });

  for (const abs of files) {
    const rel = path.relative(db, abs).split(path.sep).join('/');
    let parsed: IndexChunk[];
    let reusableLexicalRecords: TermFrequencies[] | undefined;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const h = md5(raw);
      newHashes[rel] = h;
      if (oldHashes[rel] === h) reusableLexicalRecords = lexicalByFile.get(rel);

      if (sourceSchema === SCHEMA_VERSION && contextVectorsReusable && !chunkerChanged && oldHashes[rel] === h && oldByFile.has(rel)) {
        const old = oldByFile.get(rel)!;
        for (const c of old) {
          if (!c.chunkHash) c.chunkHash = chunkHash(model, c);
        }
        for (let oldPosition = 0; oldPosition < old.length; oldPosition++) {
          const c = old[oldPosition];
          if (c.vec && reusableVector(c.vec)) {
            appendChunk(c, reusableLexicalRecords?.[oldPosition]);
            reused++;
          } else {
            c.vec = undefined;
            toEmbed.push(c);
            appendChunk(c, reusableLexicalRecords?.[oldPosition]);
          }
        }
        continue;
      }
      changedFiles++;
      parsed = parseFile(abs, db, undefined, raw, effectiveChunkTokens);
    } catch (e: any) {
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
      appendChunk(c, reusableLexicalRecords?.[parsedPosition] ?? lexicalByIdentity.get(lexicalIdentity(c)));
    }
  }

  if (toEmbed.length > 0) {
    log(`Embedding ${toEmbed.length} chunks from ${changedFiles} changed file(s) with ${model.id}...`);
    const embedStartTime = Date.now();
    let completedBatches = 0;
    const concurrency = Math.max(1, Math.min(workers || 1, 16));

    if (concurrency <= 1 || toEmbed.length <= BATCH) {
      for (let i = 0; i < toEmbed.length; i += BATCH) {
        const slice = toEmbed.slice(i, i + BATCH);
        const vecs = await embedFn(slice.map(canonicalPassage), 'passage', model, cacheDir, offline, {
          maxRetries,
          log,
        });
        let batchDim = buildDim;
        try {
          if (!Array.isArray(vecs) || vecs.length !== slice.length) throw new Error('batch size');
          if (vecs.length > 0 && batchDim === undefined) {
            batchDim = validateNumericVector(vecs[0], undefined, 'embedding vector 0');
          }
          for (const vec of vecs) validateNumericVector(vec, batchDim, 'embedding vector');
        } catch {
          throw new Error(
            `embedding returned invalid vectors` +
              (batchDim === undefined ? '' : ` (expected ${batchDim} dims)`) +
              ' — run `mdss index` to rebuild'
          );
        }
        buildDim = batchDim;
        slice.forEach((c, j) => {
          c.vec = vecs[j];
        });
        completedBatches++;
        if (completedBatches % CHECKPOINT_BATCHES === 0 && Date.now() - lastCheckpointAt >= CHECKPOINT_MIN_INTERVAL_MS) {
          lastCheckpointAt = Date.now();
          atomicWrite(checkpointPath, JSON.stringify(checkpointSnapshot(false)));
        }
        const done = Math.min(i + BATCH, toEmbed.length);
        const elapsedSec = (Date.now() - embedStartTime) / 1000;
        const chunksPerSec = elapsedSec > 0 ? done / elapsedSec : 0;
        onProgress?.(done, toEmbed.length, chunksPerSec);
        log(`  ${done}/${toEmbed.length}`);
      }
    } else {
      const batches: Array<{ slice: any[] }> = [];
      for (let i = 0; i < toEmbed.length; i += BATCH) {
        batches.push({ slice: toEmbed.slice(i, i + BATCH) });
      }

      let currentBatchIdx = 0;
      let embeddedCount = 0;

      const runWorker = async () => {
        while (currentBatchIdx < batches.length) {
          const idx = currentBatchIdx++;
          const { slice } = batches[idx];
          const vecs = await embedFn(slice.map(canonicalPassage), 'passage', model, cacheDir, offline, {
            maxRetries,
            log,
          });
          let batchDim = buildDim;
          try {
            if (!Array.isArray(vecs) || vecs.length !== slice.length) throw new Error('batch size');
            if (vecs.length > 0 && batchDim === undefined) {
              batchDim = validateNumericVector(vecs[0], undefined, 'embedding vector 0');
            }
            for (const vec of vecs) validateNumericVector(vec, batchDim, 'embedding vector');
          } catch {
            throw new Error(
              `embedding returned invalid vectors` +
                (batchDim === undefined ? '' : ` (expected ${batchDim} dims)`) +
                ' — run `mdss index` to rebuild'
            );
          }
          buildDim = batchDim;
          slice.forEach((c, j) => {
            c.vec = vecs[j];
          });
          completedBatches++;
          embeddedCount += slice.length;
          if (completedBatches % CHECKPOINT_BATCHES === 0 && Date.now() - lastCheckpointAt >= CHECKPOINT_MIN_INTERVAL_MS) {
            lastCheckpointAt = Date.now();
            atomicWrite(checkpointPath, JSON.stringify(checkpointSnapshot(false)));
          }
          const elapsedSec = (Date.now() - embedStartTime) / 1000;
          const chunksPerSec = elapsedSec > 0 ? embeddedCount / elapsedSec : 0;
          onProgress?.(embeddedCount, toEmbed.length, chunksPerSec);
          log(`  ${embeddedCount}/${toEmbed.length}`);
        }
      };

      const workerPromises: Promise<void>[] = [];
      for (let w = 0; w < concurrency; w++) {
        workerPromises.push(runWorker());
      }
      await Promise.all(workerPromises);
    }
  }

  if (chunks.some((c) => !c.vec)) {
    throw new Error('Embedding finished without a vector for every chunk.');
  }
  for (const chunk of chunks) acceptBuildVector(chunk.vec);
  const dim = buildDim ?? (model.dim > 0 ? model.dim : undefined);
  resolveIndexDimension(dim, model.dim);
  const index = {
    schemaVersion: SCHEMA_VERSION,
    format: INDEX_FORMAT,
    model: modelIdentity,
    modelAlias: typeof modelName === 'string' ? modelName || 'e5-base' : model.id,
    adapterFingerprint,
    chunkBudget: chunkBudgetMarker,
    ...(dim === undefined ? {} : { dim }),
    db,
    built: new Date().toISOString(),
    chunkCount: chunks.length,
    lexical: buildLexicalIndex(lexicalRecords),
    chunks: chunks.map((c) => ({ ...c, vec: c.vec ? (typeof c.vec === 'string' ? c.vec : encodeVec(c.vec)) : undefined })),
  };

  validateIndexEnvelope(index, 'generated index', { encoding: 'stored' });

  atomicWrite(checkpointPath, JSON.stringify({ ...index, complete: true, hashes: newHashes }));
  atomicWrite(vectorsPath, JSON.stringify(index));
  atomicWrite(hashesPath, JSON.stringify(newHashes, null, 2));

  const vectorsBinPath = path.join(indexDir, 'vectors.bin');
  if (dim !== undefined && dim > 0) {
    const binBuffer = serializeBinaryIndex(index as any, dim, { quantize });
    atomicWrite(vectorsBinPath, binBuffer);
  }

  // issue #201: ANN sidecar engine — explicit 'hnsw' builds the graph
  // instead of IVF; `true`/undefined/'ivf' keep the historical ivf.json path.
  const annEngine = ann === 'hnsw' ? 'hnsw' : 'ivf';
  const buildSidecar = Boolean(ann) || chunks.length >= ANN_THRESHOLD;
  const ivfPath = path.join(indexDir, 'ivf.json');
  const hnswPath = path.join(indexDir, 'hnsw.json');
  if (buildSidecar) {
    const rawVecs = chunks.map((c) => (c.vec instanceof Float32Array ? c.vec : Float32Array.from(c.vec as number[])));
    if (annEngine === 'hnsw') {
      const hnswIndex: HnswIndex = buildHnsw(rawVecs, {
        vectors: rawVecs,
        // cosine distance (lower = closer) over the flat normalized vectors
        distance: (a, b) => {
          const bv = rawVecs[b];
          let dot = 0;
          for (let i = 0; i < a.length; i++) dot += (a as ArrayLike<number>)[i] * (bv as ArrayLike<number>)[i];
          return 1 - dot;
        },
      });
      atomicWrite(hnswPath, JSON.stringify(serializeHnsw(hnswIndex)));
      if (fs.existsSync(ivfPath)) {
        try {
          fs.unlinkSync(ivfPath);
        } catch {}
      }
    } else {
      const ivfIndex = trainIVF(rawVecs);
      atomicWrite(ivfPath, JSON.stringify(serializeIVF(ivfIndex)));
      if (fs.existsSync(hnswPath)) {
        try {
          fs.unlinkSync(hnswPath);
        } catch {}
      }
    }
  } else {
    for (const sidecar of [ivfPath, hnswPath]) {
      if (fs.existsSync(sidecar)) {
        try {
          fs.unlinkSync(sidecar);
        } catch {}
      }
    }
  }

  fs.unlinkSync(checkpointPath);

  return {
    files: files.length,
    skipped,
    chunks: chunks.length,
    reused,
    reusedChunks,
    reusedFiles: reused - reusedChunks,
    embedded: toEmbed.length,
    dim: dim ?? 0,
    model: model.id,
    vectorsPath,
  };
}

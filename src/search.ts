import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { embed, cosine, decodeVec, globToRegExp, walkMarkdown, ModelDescriptor } from './core.js';
import { validateIndexEnvelope, validateNumericVector } from './index-format.js';
import { rerankScores } from './rerank.js';
import { bm25Scores, matchingTerms, tokenize, fuzzyTitleAliasScores, LexicalIndex } from './lexical.js';
import { collapseResults } from './collapse.js';
import { DocumentMetadata } from './frontmatter.js';
import { trainIVF, searchIVFCandidates, deserializeIVF, IVFIndex, ANN_THRESHOLD, DEFAULT_NPROBE } from './ivf.js';
import { buildRelationshipGraph, computePageRank, expandGraphNeighborhood, RelationshipGraph } from './wikilinks.js';
import { evaluateFilter, FilterNode } from './filter.js';
import { deserializeBinaryIndex } from './binary-format.js';
import { dequantizeFromInt8 } from './quantization.js';
import { buildDiskKey, diskQueryGet, diskQueryPut } from './query-cache-disk.js';

export { tokenize } from './lexical.js';

const chunkTokens = new WeakMap<IndexChunk, Set<string>>();
export const _stats = { corpusTokenizedChars: 0 };

function tokenSet(c: IndexChunk): Set<string> {
  let s = chunkTokens.get(c);
  if (!s) {
    const text = `${c.title} ${c.heading} ${c.text}`;
    _stats.corpusTokenizedChars += text.length;
    s = new Set(tokenize(text));
    chunkTokens.set(c, s);
  }
  return s;
}

export function keywordScores(chunks: IndexChunk[], query: string): number[] {
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return chunks.map(() => 0);
  return chunks.map((c) => {
    const hay = tokenSet(c);
    let s = 0;
    for (const t of qTerms) if (hay.has(t)) s++;
    return s;
  });
}

export function rrf(
  rankings: Array<Array<{ idx: number; score: number }>>,
  k = 60,
  weights?: number[]
): Map<number, number> {
  const fused = new Map<number, number>();
  for (let rankingIdx = 0; rankingIdx < rankings.length; rankingIdx++) {
    const ranking = rankings[rankingIdx];
    const weight = weights ? (weights[rankingIdx] ?? 1) : 1;
    if (weight <= 0) continue;
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    let scoreRank = 0;
    sorted.forEach((item, rank) => {
      if (item.score <= 0) return;
      if (rank > 0 && item.score < sorted[rank - 1].score) scoreRank = rank;
      fused.set(item.idx, (fused.get(item.idx) || 0) + weight / (k + scoreRank + 1));
    });
  }
  return fused;
}

export interface IndexChunk {
  file: string;
  title: string;
  heading: string;
  headingPath?: string[];
  text: string;
  vec: number[] | Float32Array;
  chunkHash?: string;
  startLine?: number;
  endLine?: number;
  meta?: DocumentMetadata;
}

export interface IndexFile {
  format?: string;
  schemaVersion?: number;
  model?: string;
  modelAlias?: string;
  dim?: number;
  built?: string;
  chunkCount?: number;
  db?: string;
  lexical?: LexicalIndex;
  chunks: IndexChunk[];
}

export class QueryEmbeddingCache {
  maxSize: number;
  cache: Map<string, Float32Array>;
  inFlight: Map<string, Promise<Float32Array>>;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  get(key: string): Float32Array | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value!);
    return value;
  }

  set(key: string, vector: number[] | Float32Array): void {
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

  async getOrCompute(key: string, fn: () => Promise<number[] | Float32Array>): Promise<Float32Array> {
    const cached = this.get(key);
    if (cached) return cached;
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!;
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

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export type LexicalState =
  | { kind: 'persisted-bm25'; lexical: LexicalIndex }
  | { kind: 'legacy-overlap' };

export interface RuntimeChunk {
  file: string;
  title: string;
  heading: string;
  headingPath?: string[];
  text: string;
  startLine?: number;
  endLine?: number;
  meta?: DocumentMetadata;
  vec: Float32Array | Int8Array;
}

export interface RuntimeIndexState {
  schema: number;
  db: string | undefined;
  chunks: RuntimeChunk[];
  lexicalState: LexicalState;
  expectedDim: number | undefined;
  model: ModelDescriptor;
  queryCache: QueryEmbeddingCache;
  ivf?: IVFIndex;
  graph?: RelationshipGraph;
  pageRank?: Map<string, number>;
}

export function getRuntimeGraph(runtime: RuntimeIndexState): { graph: RelationshipGraph; pageRank: Map<string, number> } {
  if (runtime.graph && runtime.pageRank) {
    return { graph: runtime.graph, pageRank: runtime.pageRank };
  }
  const docsMap = new Map<string, { file: string; title?: string; meta?: DocumentMetadata; text?: string }>();
  for (const chunk of runtime.chunks) {
    const existing = docsMap.get(chunk.file);
    if (!existing) {
      docsMap.set(chunk.file, {
        file: chunk.file,
        title: chunk.title,
        meta: chunk.meta,
        text: chunk.text,
      });
    } else {
      existing.text = (existing.text || '') + '\n' + chunk.text;
    }
  }
  const docs = Array.from(docsMap.values());
  const graph = buildRelationshipGraph(docs);
  const pageRank = computePageRank(graph);
  runtime.graph = graph;
  runtime.pageRank = pageRank;
  return { graph, pageRank };
}

/**
 * Issue #127 pure helpers — exported for deterministic unit tests.
 */
/** Frontmatter `created` → `updated` → file mtime; null when nothing parses. */
export function resolvePassageAgeMs(
  meta: { created?: unknown; updated?: unknown } | undefined,
  absFile?: string,
): number | null {
  for (const v of [meta?.created, meta?.updated]) {
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  if (absFile) {
    try {
      return fs.statSync(absFile).mtimeMs;
    } catch {
      /* file gone — treat as unknown age */
    }
  }
  return null;
}

/** Multiplicative recency boost: 0.5^(ageDays / halfLifeDays); 1 when off/unknown/future. */
export function recencyBoost(ageMs: number | null, halfLifeDays: number, now: number = Date.now()): number {
  if (ageMs === null || !(halfLifeDays > 0)) return 1;
  const ageDays = Math.max(0, (now - ageMs) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

const runtimeIndexStates = new WeakMap<IndexFile, RuntimeIndexState>();

function snapshotRuntimeIndex(
  index: IndexFile,
  validation: {
    schema: number;
    dim: number | undefined;
    model: ModelDescriptor;
    ivf?: IVFIndex;
    rawVectorsBuffer?: Float32Array | Int8Array;
  }
): RuntimeIndexState {
  const dim = validation.dim || (index.chunks[0]?.vec?.length ?? 0);
  const count = index.chunks.length;
  const isZeroCopy = !!validation.rawVectorsBuffer;
  const vectorsBuffer = validation.rawVectorsBuffer ?? (dim > 0 ? new Float32Array(count * dim) : null);

  const chunks: RuntimeChunk[] = index.chunks.map((chunk, i) => {
    let vec: Float32Array | Int8Array;
    if (vectorsBuffer && dim > 0) {
      const offset = i * dim;
      if (!isZeroCopy) {
        if (chunk.vec instanceof Float32Array || chunk.vec instanceof Int8Array) {
          (vectorsBuffer as any).set(chunk.vec, offset);
        } else {
          const arr = chunk.vec as number[];
          for (let j = 0; j < dim; j++) (vectorsBuffer as any)[offset + j] = arr[j];
        }
      }
      vec = (vectorsBuffer as any).subarray(offset, offset + dim);
    } else {
      vec = Float32Array.from(chunk.vec as number[]);
    }

    return {
      file: chunk.file,
      title: chunk.title,
      heading: chunk.heading,
      headingPath: chunk.headingPath,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      meta: chunk.meta,
      vec,
    };
  });

  let lexicalState: LexicalState = { kind: 'legacy-overlap' };
  if (validation.schema >= 3 && index.lexical) {
    const postings: Record<string, Array<[number, number]>> = Object.create(null);
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
    ivf: validation.ivf,
  };
}

function validateRuntimeIndex(index: IndexFile): RuntimeIndexState {
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

function warnIfStale(index: IndexFile): void {
  if (!index.db || !index.built) return;
  const builtMs = Date.parse(index.built);
  if (!Number.isFinite(builtMs)) return;
  let newest = 0;
  try {
    for (const f of walkMarkdown(index.db)) {
      const st = fs.statSync(f);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  } catch {
    return;
  }
  if (newest <= builtMs + 5000) return;
  const mins = Math.max(1, Math.round((newest - builtMs) / 60000));
  process.stderr.write(
    `warning: index is ${mins} min older than the newest change in ${index.db}; run \`mdss index\` to refresh.\n`
  );
}

export function loadIndex(indexDir: string): { index: IndexFile; model: ModelDescriptor } {
  const vectorsBinPath = path.join(indexDir, 'vectors.bin');
  const vectorsPath = path.join(indexDir, 'vectors.json');

  let useBinary = false;
  if (fs.existsSync(vectorsBinPath)) {
    if (!fs.existsSync(vectorsPath)) {
      useBinary = true;
    } else {
      try {
        const binStat = fs.statSync(vectorsBinPath);
        const jsonStat = fs.statSync(vectorsPath);
        if (binStat.mtimeMs >= jsonStat.mtimeMs) {
          useBinary = true;
        }
      } catch {
        useBinary = false;
      }
    }
  }

  if (useBinary) {
    try {
      const binBuffer = fs.readFileSync(vectorsBinPath);
      const shaBinPath = path.join(indexDir, 'vectors.bin.sha256');
      if (fs.existsSync(shaBinPath)) {
        const expectedHash = fs.readFileSync(shaBinPath, 'utf8').trim().split(/\s+/)[0];
        const actualHash = crypto.createHash('sha256').update(binBuffer).digest('hex');
        if (expectedHash && actualHash !== expectedHash) {
          throw new Error('vectors.bin integrity check failed (SHA-256 mismatch) — run `mdss index` to rebuild.');
        }
      }
      const deserialized = deserializeBinaryIndex(binBuffer);
      const validated = validateIndexEnvelope(deserialized, vectorsBinPath, { encoding: 'loaded', validateVectors: true });
      const index = validated.index as IndexFile;
      const { model, dim: validatedDim } = validated;
      const expectedDim = validatedDim ?? deserialized.dim;

      warnIfStale(index);

      const ivfPath = path.join(indexDir, 'ivf.json');
      let ivf: IVFIndex | undefined;
      if (fs.existsSync(ivfPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(ivfPath, 'utf8'));
          ivf = deserializeIVF(raw);
        } catch {}
      }

      runtimeIndexStates.set(
        index,
        snapshotRuntimeIndex(index, {
          schema: validated.schema,
          dim: expectedDim,
          model,
          ivf,
          rawVectorsBuffer: deserialized.rawVectorsBuffer,
        })
      );

      return { index, model };
    } catch (e: any) {
      if (e.message?.includes('integrity check failed')) throw e;
      if (!fs.existsSync(vectorsPath)) throw e;
      // If vectors.bin was corrupt or unreadable, fall through to vectors.json fallback
    }
  }

  if (!fs.existsSync(vectorsPath)) {
    throw new Error(`No index at ${vectorsPath}. Run \`mdss index\` first.`);
  }
  const rawBytes = fs.readFileSync(vectorsPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes);
  } catch (e: any) {
    throw new Error(`${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild.`, { cause: e });
  }
  const validated = validateIndexEnvelope(parsed, vectorsPath, { encoding: 'stored' });
  const index = validated.index as IndexFile;

  const shaPath = path.join(indexDir, 'vectors.json.sha256');
  if (fs.existsSync(shaPath)) {
    try {
      const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
      const expectedHash = shaContent.split(/\s+/)[0];
      const actualHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
      if (expectedHash && actualHash !== expectedHash) {
        throw new Error(`vectors.json integrity check failed (SHA-256 mismatch) — run \`mdss index\` to rebuild.`);
      }
    } catch (e: any) {
      if (e.message.includes('integrity check failed')) throw e;
    }
  }

  const { model, dim: validatedDim } = validated;
  let expectedDim = validatedDim;

  if (!index.model && !index.modelAlias) {
    process.stderr.write(
      'warning: index has no "model" field (built by an old version); assuming the default model. Re-run `mdss index` to refresh.\n'
    );
  }

  for (let position = 0; position < index.chunks.length; position++) {
    const c = index.chunks[position];
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`chunk ${position} must be an object — run \`mdss index\` to rebuild`);
    }
    if (typeof c.vec === 'string') {
      if (index.format !== 'binary-v1') {
        throw new Error(`chunk ${c.file}: unexpected base64 vector in a legacy decimal index — run \`mdss index\` to rebuild`);
      }
      try {
        c.vec = decodeVec(c.vec, expectedDim);
        expectedDim ??= c.vec.length;
      } catch (e: any) {
        const where = c.file + (c.heading ? ` › ${c.heading}` : '');
        throw new Error(`chunk ${where}: ${e.message}`, { cause: e });
      }
    } else {
      const where = c.file + (c.heading ? ` › ${c.heading}` : '');
      const length = validateNumericVector(c.vec, expectedDim, `chunk ${where}`);
      expectedDim ??= length;
    }
  }

  warnIfStale(index);

  const ivfPath = path.join(indexDir, 'ivf.json');
  let ivf: IVFIndex | undefined;
  if (fs.existsSync(ivfPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ivfPath, 'utf8'));
      ivf = deserializeIVF(raw);
    } catch {}
  }

  runtimeIndexStates.set(index, snapshotRuntimeIndex(index, { schema: validated.schema, dim: expectedDim, model, ivf }));

  return { index, model };
}

export const MAX_QUERY_LENGTH = 2048;

export interface LoadedIndex {
  index: IndexFile;
  model: ModelDescriptor;
}

export interface SearchOptions {
  loaded: LoadedIndex;
  cacheDir: string;
  query: string;
  k?: number;
  semanticOnly?: boolean;
  offline?: boolean;
  path?: string | string[];
  since?: string | Date;
  rerank?: boolean;
  rerankPool?: number;
  rerankFn?: any;
  embedFn?: any;
  tag?: string | string[];
  project?: string;
  type?: string;
  status?: string;
  canonicalOnly?: boolean;
  custom?: Record<string, unknown>;
  explain?: boolean;
  maxPerFile?: number;
  maxPerDoc?: number;
  useQueryCache?: boolean;
  /** issue #114: persist query embeddings to <cacheDir>/query-cache.json (default on). */
  queryDiskCache?: boolean;
  /** issue #127: time-decay half-life in days; boost = 0.5^(ageDays/halfLife). Omitted = off. */
  recency?: number;
  ann?: boolean;
  nprobe?: number;
  graphBoost?: number;
  filter?: string | FilterNode;
}

export interface SearchResultHit {
  file: string;
  title: string;
  heading: string;
  cosine: number;
  score: number;
  matches: string[];
  snippet: string;
  meta?: DocumentMetadata;
  graphScore?: number;
  explain?: {
    cosine: number;
    rrfScore: number;
    bm25Weights: { title: number; aliases: number; headingPath: number; body: number };
    graphScore?: number;
    pageRank?: number;
  };
  rerankScore?: number;
}

export async function searchIndex(opts: SearchOptions): Promise<SearchResultHit[]> {
  const {
    loaded,
    cacheDir,
    query,
    k = 6,
    semanticOnly = false,
    offline = false,
    path: pathFilter,
    since,
    rerank = false,
    rerankPool,
    tag,
    project,
    type,
    status,
    canonicalOnly,
    custom,
    filter: filterExpr,
  } = opts;

  const graphBoost = typeof opts.graphBoost === 'number' && Number.isFinite(opts.graphBoost) ? opts.graphBoost : 0;

  if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const embedFn = opts.embedFn ?? embed;
  const rerankFn = opts.rerankFn ?? rerankScores;
  const { index } = loaded;
  const runtime = validateRuntimeIndex(index);
  const { chunks, db, lexicalState, expectedDim } = runtime;

  const pathRes = pathFilter ? (Array.isArray(pathFilter) ? pathFilter : [pathFilter]).map(globToRegExp) : [];
  let sinceMs: number | undefined;
  if (since !== undefined) {
    sinceMs = since instanceof Date ? since.getTime() : Date.parse(String(since));
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since date: "${since}" (use YYYY-MM-DD or ISO 8601)`);
  }
  let candidates = chunks.map((chunk, idx) => ({ chunk, idx }));
  const hasMetaFilter =
    tag !== undefined ||
    project !== undefined ||
    type !== undefined ||
    status !== undefined ||
    canonicalOnly !== undefined ||
    custom !== undefined ||
    filterExpr !== undefined;

  if (pathRes.length > 0 || sinceMs !== undefined || hasMetaFilter) {
    if (sinceMs !== undefined && !db) {
      throw new Error('--since requires an index that knows its --db (index.db missing). Re-run `mdss index`.');
    }
    const mtimeCache = new Map<string, number>();
    candidates = candidates.filter(({ chunk }) => {
      if (pathRes.length > 0 && !pathRes.some((re) => re.test(chunk.file))) return false;
      if (sinceMs !== undefined) {
        let m = mtimeCache.get(chunk.file);
        if (m === undefined) {
          try {
            m = fs.statSync(path.join(db!, chunk.file)).mtimeMs;
          } catch {
            m = -Infinity;
          }
          mtimeCache.set(chunk.file, m);
        }
        if (m < sinceMs) return false;
      }
      if (filterExpr !== undefined) {
        if (!evaluateFilter(filterExpr, chunk.meta, { file: chunk.file, title: chunk.title })) return false;
      }
      if (tag !== undefined) {
        const reqTags = (Array.isArray(tag) ? tag : [tag]).map((t) => String(t).toLowerCase().replace(/^#/, ''));
        const chunkTags = chunk.meta?.tags || [];
        if (!reqTags.every((rt) => chunkTags.includes(rt))) return false;
      }
      if (project !== undefined && chunk.meta?.project !== project) return false;
      if (type !== undefined && chunk.meta?.type !== type) return false;
      if (status !== undefined && chunk.meta?.status !== status) return false;
      if (canonicalOnly && chunk.meta?.canonical === false) return false;
      if (custom && typeof custom === 'object') {
        for (const [key, value] of Object.entries(custom)) {
          if (chunk.meta?.custom?.[key] !== value) return false;
        }
      }
      return true;
    });
  }

  let qVec: Float32Array | number[];
  if (opts.useQueryCache !== false && runtime.queryCache) {
    const normQuery = query.trim().toLowerCase();
    const cacheKey = `${runtime.model.id}:${runtime.model.revision || 'main'}:${expectedDim || 0}:${normQuery}`;
    // L2 disk layer (issue #114): persists across processes under cacheDir;
    // corrupt/missing files degrade silently to a normal embed.
    const diskKey = buildDiskKey(runtime.model.id, runtime.model.revision || 'main', expectedDim, normQuery);
    const useDisk = opts.queryDiskCache !== false;
    qVec = await runtime.queryCache.getOrCompute(cacheKey, async () => {
      if (useDisk) {
        const fromDisk = diskQueryGet(cacheDir, diskKey, expectedDim);
        if (fromDisk) return fromDisk;
      }
      const [v] = await embedFn([query], 'query', runtime.model, cacheDir, offline);
      if ((Array.isArray(v) || v instanceof Float32Array) && expectedDim !== undefined && v.length !== expectedDim) {
        throw new Error(`query vector has ${v.length} dims, expected ${expectedDim} - run \`mdss index\` to rebuild`);
      }
      validateNumericVector(v, undefined, 'query vector');
      if (useDisk) diskQueryPut(cacheDir, diskKey, v);
      return v;
    });
  } else {
    const [v] = await embedFn([query], 'query', runtime.model, cacheDir, offline);
    if ((Array.isArray(v) || v instanceof Float32Array) && expectedDim !== undefined && v.length !== expectedDim) {
      throw new Error(`query vector has ${v.length} dims, expected ${expectedDim} — run \`mdss index\` to rebuild`);
    }
    validateNumericVector(v, undefined, 'query vector');
    qVec = v;
  }
  const queryTerms = [...new Set(tokenize(query))];

  let semantic: Array<{ idx: number; score: number }>;
  const useAnn = opts.ann ?? (runtime.ivf !== undefined && candidates.length >= ANN_THRESHOLD);
  if (useAnn && candidates.length >= ANN_THRESHOLD) {
    if (!runtime.ivf) {
      const rawVecs = chunks.map((c) => (c.vec instanceof Float32Array ? c.vec : dequantizeFromInt8(c.vec)));
      runtime.ivf = trainIVF(rawVecs);
    }
    const qVecF32 = qVec instanceof Float32Array ? qVec : Float32Array.from(qVec);
    const probedSet = new Set(searchIVFCandidates(qVecF32, runtime.ivf, opts.nprobe ?? DEFAULT_NPROBE));
    semantic = candidates.map(({ chunk, idx }) => {
      if (!probedSet.has(idx)) {
        return { idx, score: -1 };
      }
      return { idx, score: cosine(qVec, chunk.vec) };
    });
  } else {
    semantic = candidates.map(({ chunk, idx }) => {
      return { idx, score: cosine(qVec, chunk.vec) };
    });
  }
  const cosByIdx = new Map(semantic.map((s) => [s.idx, s.score]));

  const pool = rerank ? rerankPool || Math.max(20, k * 3) : k;

  let graphRanking: Array<{ idx: number; score: number }> = [];
  let graphMap: Map<number, number> | undefined;
  if (graphBoost > 0) {
    const { graph, pageRank } = getRuntimeGraph(runtime);
    const seedFilesMap = new Map<string, number>();
    for (const s of semantic) {
      if (s.score > 0) {
        const file = chunks[s.idx].file;
        const curr = seedFilesMap.get(file) || 0;
        if (s.score > curr) seedFilesMap.set(file, s.score);
      }
    }
    const seedFiles = Array.from(seedFilesMap.entries()).map(([file, score]) => ({ file, score }));
    const propagationScores = expandGraphNeighborhood(graph, seedFiles, { maxDepth: 2, decay: 0.5 });

    graphMap = new Map<number, number>();
    graphRanking = candidates.map(({ chunk, idx }) => {
      const pr = pageRank.get(chunk.file) || 0;
      const prop = propagationScores.get(chunk.file) || 0;
      const totalGraph = pr + prop;
      graphMap!.set(idx, totalGraph);
      return { idx, score: totalGraph };
    });
  }

  let ranked: Array<{ idx: number; fscore: number; cos: number; rerank?: number; rawFscore?: number; recencyFactor?: number; recencyAgeDays?: number | null }>;
  if (semanticOnly) {
    if (graphBoost > 0) {
      const fused = rrf([semantic, graphRanking], 60, [1, graphBoost]);
      ranked = [...fused.entries()]
        .map(([idx, fscore]) => ({ idx, fscore, cos: cosByIdx.get(idx)! }))
        .sort((a, b) => b.fscore - a.fscore)
        .slice(0, pool);
    } else {
      ranked = [...semantic]
        .sort((a, b) => b.score - a.score)
        .slice(0, pool)
        .map((s) => ({ idx: s.idx, fscore: s.score, cos: s.score }));
    }
  } else {
    const kw =
      lexicalState.kind === 'persisted-bm25'
        ? [...bm25Scores(lexicalState.lexical, queryTerms, new Set(candidates.map((c) => c.idx))).entries()].map(
            ([idx, score]) => ({ idx, score })
          )
        : keywordScores(candidates.map((c) => c.chunk as any), query).map((score, position) => ({
            idx: candidates[position].idx,
            score,
          }));

    const fuzzy = [...fuzzyTitleAliasScores(candidates.map((c) => c.chunk), query).entries()].map(([position, score]) => ({
      idx: candidates[position].idx,
      score,
    }));

    if (graphBoost > 0) {
      const fused = rrf([semantic, kw, fuzzy, graphRanking], 60, [1, 1, 1, graphBoost]);
      ranked = [...fused.entries()]
        .map(([idx, fscore]) => ({ idx, fscore, cos: cosByIdx.get(idx)! }))
        .sort((a, b) => b.fscore - a.fscore)
        .slice(0, pool);
    } else {
      const fused = rrf([semantic, kw, fuzzy]);
      ranked = [...fused.entries()]
        .map(([idx, fscore]) => ({ idx, fscore, cos: cosByIdx.get(idx)! }))
        .sort((a, b) => b.fscore - a.fscore)
        .slice(0, pool);
    }
  }

  // Issue #127: time-decay recency boost — multiply the fused score by
  // 0.5^(ageDays / halfLifeDays), post-RRF and pre-collapse. Age source
  // priority: frontmatter `created` → `updated` → file mtime. Missing dates
  // get factor 1 (evergreen content stays reachable via lexical strength).
  const recencyHalfLife = Number(opts.recency) > 0 ? Number(opts.recency) : 0;
  if (recencyHalfLife > 0) {
    const now = Date.now();
    const ageCache = new Map<string, number | null>();
    for (const r of ranked) {
      const c = chunks[r.idx];
      const abs = runtime.db && !path.isAbsolute(c.file) ? path.join(runtime.db, c.file) : c.file;
      const ageKey = `${c.file}|${c.meta?.updated ?? ''}|${c.meta?.created ?? ''}`;
      if (!ageCache.has(ageKey)) ageCache.set(ageKey, resolvePassageAgeMs(c.meta, abs));
      const ageMs = ageCache.get(ageKey) ?? null;
      r.recencyFactor = recencyBoost(ageMs, recencyHalfLife, now);
      r.recencyAgeDays = ageMs === null ? null : Math.max(0, (now - ageMs) / 86_400_000);
      r.rawFscore = r.fscore;
      r.fscore = r.fscore * r.recencyFactor;
    }
    ranked.sort((a, b) => b.fscore - a.fscore);
  }

  if (rerank && ranked.length > 0) {
    const texts = ranked.map((r) => chunks[r.idx].text);
    const scores = await rerankFn(query, texts, cacheDir, offline);
    ranked = ranked
      .map((r, i) => ({ ...r, rerank: scores[i] ?? -Infinity }))
      .sort((a, b) => b.rerank - a.rerank)
      .slice(0, k);
  }

  const hasMetaFields = (m?: DocumentMetadata) =>
    Boolean(
      m &&
        (m.tags?.length > 0 ||
          m.aliases?.length > 0 ||
          m.project ||
          m.type ||
          m.status ||
          m.canonical !== undefined ||
          m.canonicalRef ||
          m.created ||
          m.updated ||
          Object.keys(m.custom || {}).length > 0)
    );

  const explain = opts.explain === true;

  const hits: SearchResultHit[] = ranked.map((r) => {
    const c = chunks[r.idx];
    const matches =
      lexicalState.kind === 'persisted-bm25'
        ? matchingTerms(lexicalState.lexical, queryTerms, r.idx)
        : queryTerms.filter((term) => tokenSet(c as any).has(term));
    const gScore = graphMap?.get(r.idx);
    const prScore = runtime.pageRank?.get(c.file);
    return {
      file: c.file,
      title: c.title,
      heading: c.heading,
      cosine: +r.cos.toFixed(3),
      score: +r.fscore.toFixed(4),
      matches,
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 220),
      ...(hasMetaFields(c.meta) ? { meta: c.meta } : {}),
      ...(gScore !== undefined ? { graphScore: +gScore.toFixed(4) } : {}),
      ...(explain
        ? {
            explain: {
              cosine: +r.cos.toFixed(4),
              rrfScore: +(r.rawFscore ?? r.fscore).toFixed(4),
              bm25Weights: { title: 3.0, aliases: 3.0, headingPath: 1.8, body: 1.0 },
              ...(gScore !== undefined ? { graphScore: +gScore.toFixed(4) } : {}),
              ...(prScore !== undefined ? { pageRank: +prScore.toFixed(4) } : {}),
              ...(r.recencyFactor !== undefined
                ? {
                    recencyFactor: +r.recencyFactor.toFixed(4),
                    recencyAgeDays:
                      r.recencyAgeDays === null || r.recencyAgeDays === undefined
                        ? null
                        : +r.recencyAgeDays.toFixed(2),
                  }
                : {}),
            },
          }
        : {}),
      ...(rerank ? { rerankScore: +(r.rerank ?? 0).toFixed(4) } : {}),
    };
  });

  const maxPerDoc = opts.maxPerFile || opts.maxPerDoc;
  if (maxPerDoc && maxPerDoc > 0) {
    return collapseResults(hits, (h) => h.meta?.canonicalRef || h.file, maxPerDoc).slice(0, k);
  }
  return hits;
}

export type OneShotSearchOptions = Omit<SearchOptions, 'loaded'> & { indexDir: string };

export async function search(opts: OneShotSearchOptions): Promise<SearchResultHit[]> {
  const { indexDir, ...rest } = opts;
  const loaded = loadIndex(indexDir);
  return searchIndex({ ...rest, loaded });
}

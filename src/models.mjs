// @ts-check
/**
 * Embedding model adapter registry (issue #60).
 *
 * Each registered model declares an EXPLICIT adapter that makes preprocessing
 * (query/document formatting), pooling, normalization, runtime dtype, token
 * budget, and dimensions auditable. The shared `embed()` path no longer infers
 * any of this from the model name — it reads the adapter fields, so adding a
 * heterogeneous family (e.g. Qwen3 with instruction queries + last-token
 * pooling) cannot silently produce wrong vectors.
 *
 * The adapter fingerprint hashes exactly the fields that change the produced
 * vectors (formatting, pooling, normalization, dimension); model weights
 * (id@revision) remain a separate identity. Unknown raw Hugging Face ids no
 * longer silently inherit E5-style `query:`/`passage:` prefixes and mean
 * pooling — they resolve to a neutral descriptor that FAILS at embed time with
 * an actionable message until an explicit adapter is provided.
 */
import crypto from 'node:crypto';

/**
 * @typedef {'mean'|'last_token'|'none'} Pooling
 *
 * Runtime ONNX data type for the Transformers.js pipeline load. A subset of
 * the valid dtype strings; `q8` is the project default (quantized weights).
 * @typedef {'q8'|'q4'|'fp16'|'fp32'|'int8'|'uint8'} DType
 *
 * @typedef {Object} ModelAdapter
 * @property {string} id - HF repo id (e.g. "Xenova/multilingual-e5-base")
 * @property {string} [revision] - pinned revision (default "main")
 * @property {number} nativeDim - native embedding dimension (>= 0 to infer)
 * @property {number} dim - canonical embedding dimension; alias of nativeDim
 *   for resolved adapters (legacy consumers read `dim`)
 * @property {number[]} [dimensions] - allowed output dimensions (MRL policy);
 *   always implicitly includes nativeDim when present
 * @property {string} queryPrefix - text prepended to every query ('' = none)
 * @property {string} passagePrefix - text prepended to every passage ('' = none)
 * @property {Pooling} pooling - token pooling strategy
 * @property {boolean} [normalize=true] - whether vectors are L2-normalized
 * @property {DType} [dtype] - runtime ONNX dtype (default 'q8')
 * @property {number} [maxTokens] - declared tokenizer budget (context window)
 * @property {Record<string, unknown>} [sessionOptions] - ONNX Runtime session options (e.g. intraOpNumThreads)
 * @property {string} [family] - formatting/pooling family key exposed by
 *   `mdss stats`/`models` (e.g. 'e5', 'bge', 'qwen3'); NOT used for routing
 * @property {string} [note] - human-readable description
 * @property {boolean} [unknownAdapter] - true only for unconfigured raw ids;
 *   such adapters are unusable for embedding until explicitly configured
 */

/**
 * Registered adapters keyed by CLI/library alias.
 * @type {Record<string, ModelAdapter>}
 */
export const MODELS = {
  'e5-small': {
    id: 'Xenova/multilingual-e5-small',
    nativeDim: 384,
    dim: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    maxTokens: 512,
    family: 'e5',
    note: 'Fastest, ~120MB. Weak cross-lingual ranking — see RESEARCH.md.',
  },
  'e5-base': {
    id: 'Xenova/multilingual-e5-base',
    nativeDim: 768,
    dim: 768,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    maxTokens: 512,
    family: 'e5',
    note: 'Default. ~280MB. Solid multilingual + cross-lingual balance.',
  },
  'e5-large': {
    id: 'Xenova/multilingual-e5-large',
    nativeDim: 1024,
    dim: 1024,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    maxTokens: 512,
    family: 'e5',
    note: '~2.2GB. Higher quality, slower.',
  },
  'bge-m3': {
    id: 'Xenova/bge-m3',
    nativeDim: 1024,
    dim: 1024,
    queryPrefix: '',
    passagePrefix: '',
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    maxTokens: 512,
    family: 'bge',
    note: '~2.3GB. Best cross-lingual separation in our tests; no prefixes.',
  },
  'qwen3-embedding-0.6b': {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    nativeDim: 1024,
    dim: 1024,
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    passagePrefix: '',
    pooling: 'last_token',
    normalize: true,
    dtype: 'q8',
    maxTokens: 32768,
    family: 'qwen3',
    note: '~613 MB q8. Opt-in Qwen3 embedding model.',
  },
};

export const DEFAULT_MODEL = 'e5-base';

/** True for the pooling strategies the pipeline accepts. */
export const POOLING = ['mean', 'last_token', 'none'];

const POOLING_SET = new Set(POOLING);

/** Map HF repo id → alias of the first registered adapter that owns it. */
const aliasByRepoId = new Map();
for (const [alias, adapter] of Object.entries(MODELS)) {
  if (!aliasByRepoId.has(adapter.id)) aliasByRepoId.set(adapter.id, alias);
}

/** Ensure a resolved adapter exposes the legacy `dim` alias for nativeDim. */
function withDim(adapter) {
  return { ...adapter, dim: adapter.nativeDim };
}

/**
 * Validate + normalize an explicit user-supplied adapter descriptor. Called
 * with the neutral unknown-raw-id shape as a guard: a descriptor that lacks the
 * vector-producing fields stays unusable.
 * @param {Partial<ModelAdapter>|ModelAdapter} raw
 * @returns {ModelAdapter}
 */
export function normalizeAdapter(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('a custom model adapter must be an object with id, pooling, normalize, and dimension');
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new Error('a custom model adapter requires a nonempty `id`');
  }
  const pooling = raw.pooling ?? 'mean';
  if (!POOLING_SET.has(pooling)) {
    throw new Error(`unsupported pooling "${pooling}" — expected one of: ${POOLING.join(', ')}`);
  }
  const nativeDim = raw.nativeDim ?? raw.dim ?? 0;
  if (!Number.isSafeInteger(nativeDim) || nativeDim < 0) {
    throw new Error(`invalid adapter dimension ${nativeDim} — must be a non-negative safe integer`);
  }
  const dimensions = raw.dimensions !== undefined
    ? (Array.isArray(raw.dimensions) && raw.dimensions.every(d => Number.isSafeInteger(d) && d > 0)
      ? [...new Set(raw.dimensions)].sort((a, b) => a - b)
      : [])
    : [];
  const adapter = withDim({
    id: raw.id,
    ...(raw.revision ? { revision: raw.revision } : {}),
    nativeDim,
    ...(dimensions.length > 0 ? { dimensions } : {}),
    queryPrefix: typeof raw.queryPrefix === 'string' ? raw.queryPrefix : '',
    passagePrefix: typeof raw.passagePrefix === 'string' ? raw.passagePrefix : '',
    pooling,
    normalize: raw.normalize !== false,
    dtype: typeof raw.dtype === 'string' && raw.dtype.length > 0 ? raw.dtype : 'q8',
    ...(Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0
      ? { maxTokens: raw.maxTokens } : {}),
    ...(typeof raw.family === 'string' && raw.family.length > 0
      ? { family: raw.family } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  });
  if (raw.unknownAdapter === true && typeof raw.dtype !== 'string') {
    return { ...adapter, unknownAdapter: true };
  }
  return adapter;
}

/**
 * Resolve a model alias, a registered id, or an explicit adapter descriptor
 * into a usable ModelAdapter.
 *
 * - alias (`e5-base`) → the registered adapter;
 * - registered repo id (± `@revision`) → the owning registered adapter;
 * - an object descriptor → validated explicit adapter (advanced/library use);
 * - ANY OTHER raw id → a NEUTRAL adapter flagged `unknownAdapter: true`. It is
 *   NOT guessed to be E5-compatible; it keeps the index readable (load/check
 *   only need id/revision/dim) but FAILS with an actionable message at embed
 *   time until the caller supplies an explicit adapter (issue #60).
 *
 * @param {string|Partial<ModelAdapter>} [name]
 * @returns {ModelAdapter}
 */
export function resolveModel(name) {
  if (name === undefined || name === null || name === '') {
    return withDim(MODELS[DEFAULT_MODEL]);
  }
  if (typeof name === 'object' && !Array.isArray(name)) {
    return normalizeAdapter(name);
  }
  if (typeof name !== 'string') {
    throw new Error(`model must be an alias, id, or adapter object — got ${typeof name}`);
  }
  if (MODELS[name]) return withDim(MODELS[name]);

  // id@revision split; default revision "main" (issue #27 keeps it in the key).
  let id = name;
  let revision = 'main';
  const at = name.indexOf('@');
  const hasExplicitRevision = at > 0;
  if (hasExplicitRevision) {
    id = name.slice(0, at);
    const requested = name.slice(at + 1);
    revision = requested === '' ? 'main' : requested;
  }
  const alias = aliasByRepoId.get(id);
  if (alias !== undefined) {
    const registered = MODELS[alias];
    const resolved = hasExplicitRevision ? { ...registered, revision } : registered;
    return withDim(resolved);
  }
  // Unknown repo id: neutral, explicit-config-required adapter.
  return normalizeAdapter({
    id,
    ...(revision !== 'main' ? { revision } : {}),
    pooling: 'none',
    normalize: false,
    nativeDim: 0,
    dim: 0,
    unknownAdapter: true,
  });
}

/**
 * The subset of adapter fields that change the produced vectors and therefore
 * participate in the adapter fingerprint. Kept as its own structural type so
 * both registered adapters and legacy pre-profile descriptors can be hashed
 * without requiring a full `ModelAdapter`.
 * @typedef {Object} FingerprintInput
 * @property {string} [queryPrefix]
 * @property {string} [passagePrefix]
 * @property {Pooling} [pooling]
 * @property {boolean} [normalize]
 * @property {number} [dim]
 * @property {number} [nativeDim]
 */

/**
 * Hash the vector-producing adapter semantics independently of model weights.
 * Model id and revision remain in the existing persisted `model` identity.
 *
 * The hashed fields are EXACTLY those that change the produced vectors:
 * formatting prefixes, pooling, normalization, and dimension. This hashing
 * contract is stable (`adapter-v1`): normalizing default fields in a registered
 * adapter must NOT change the bytes, so existing schema-v3 indexes and
 * checkpoints built with E5/BGE keep their vectors reusable.
 *
 * @param {FingerprintInput} model
 */
export function embeddingAdapterFingerprint(model) {
  const semantics = [
    'embedding-adapter-v1',
    `query-prefix:${model.queryPrefix ?? ''}`,
    `passage-prefix:${model.passagePrefix ?? ''}`,
    `pooling:${model.pooling ?? 'mean'}`,
    `normalize:${model.normalize !== false}`,
    `dimension:${model.nativeDim ?? model.dim ?? 0}`,
  ].join('\u0000');
  return `adapter-v1:${crypto.createHash('sha256').update(semantics).digest('hex')}`;
}

/**
 * Adapter semantics used before registered model profiles (#50): the generic
 * E5-style prefixes + mean pooling that once applied to every raw id (except a
 * heuristic `bge` name match). Kept so pre-profile indexes remain readable and
 * re-usable (see indexer `adapterCompatible`).
 * @param {{id:string, dim:number, nativeDim?:number}} model
 */
export function legacyEmbeddingAdapterFingerprint(model) {
  const isBge = /bge/i.test(model.id);
  return embeddingAdapterFingerprint({
    nativeDim: model.nativeDim ?? model.dim,
    queryPrefix: isBge ? '' : 'query: ',
    passagePrefix: isBge ? '' : 'passage: ',
    pooling: 'mean',
    normalize: true,
  });
}

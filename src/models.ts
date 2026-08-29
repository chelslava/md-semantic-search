/**
 * Embedding model adapter registry (issue #60).
 */
import crypto from 'node:crypto';

export type Pooling = 'mean' | 'last_token' | 'none';
export type DType = 'q8' | 'q4' | 'fp16' | 'fp32' | 'int8' | 'uint8';

export interface ModelAdapter {
  id: string;
  revision?: string;
  nativeDim: number;
  dim: number;
  dimensions?: number[];
  queryPrefix: string;
  passagePrefix: string;
  pooling: Pooling;
  normalize?: boolean;
  dtype?: DType | string;
  maxTokens?: number;
  sessionOptions?: Record<string, unknown>;
  family?: string;
  note?: string;
  unknownAdapter?: boolean;
}

export const MODELS: Record<string, ModelAdapter> = {
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
    dimensions: [64, 128, 256, 512, 1024],
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
    dimensions: [32, 64, 128, 256, 512, 768, 1024],
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    passagePrefix: '',
    pooling: 'last_token',
    normalize: true,
    dtype: 'q8',
    maxTokens: 32768,
    family: 'qwen3',
    note: '~613 MB q8. Opt-in Qwen3 embedding model with Matryoshka/MRL support.',
  },
};

export const DEFAULT_MODEL = 'e5-base';
export const POOLING: Pooling[] = ['mean', 'last_token', 'none'];
const POOLING_SET = new Set<string>(POOLING);

const aliasByRepoId = new Map<string, string>();
for (const [alias, adapter] of Object.entries(MODELS)) {
  if (!aliasByRepoId.has(adapter.id)) aliasByRepoId.set(adapter.id, alias);
}

function withDim(adapter: ModelAdapter): ModelAdapter {
  return { ...adapter, dim: adapter.nativeDim ?? adapter.dim };
}

export function normalizeAdapter(raw: Partial<ModelAdapter> | ModelAdapter): ModelAdapter {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('a custom model adapter must be an object with id, pooling, normalize, and dimension');
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new Error('a custom model adapter requires a nonempty `id`');
  }
  const pooling: Pooling = (raw.pooling as Pooling) ?? 'mean';
  if (!POOLING_SET.has(pooling)) {
    throw new Error(`unsupported pooling "${pooling}" — expected one of: ${POOLING.join(', ')}`);
  }
  const nativeDim = raw.nativeDim ?? raw.dim ?? 0;
  if (!Number.isSafeInteger(nativeDim) || nativeDim < 0) {
    throw new Error(`invalid adapter dimension ${nativeDim} — must be a non-negative safe integer`);
  }
  const dimensions =
    raw.dimensions !== undefined
      ? Array.isArray(raw.dimensions) && raw.dimensions.every((d) => Number.isSafeInteger(d) && d > 0)
        ? [...new Set(raw.dimensions)].sort((a, b) => a - b)
        : []
      : [];
  const adapter = withDim({
    id: raw.id,
    ...(raw.revision ? { revision: raw.revision } : {}),
    nativeDim,
    dim: nativeDim,
    ...(dimensions.length > 0 ? { dimensions } : {}),
    queryPrefix: typeof raw.queryPrefix === 'string' ? raw.queryPrefix : '',
    passagePrefix: typeof raw.passagePrefix === 'string' ? raw.passagePrefix : '',
    pooling,
    normalize: raw.normalize !== false,
    dtype: typeof raw.dtype === 'string' && raw.dtype.length > 0 ? raw.dtype : 'q8',
    ...(Number.isSafeInteger(raw.maxTokens) && raw.maxTokens && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
    ...(typeof raw.family === 'string' && raw.family.length > 0 ? { family: raw.family } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  });
  if (raw.unknownAdapter === true && typeof raw.dtype !== 'string') {
    return { ...adapter, unknownAdapter: true };
  }
  return adapter;
}

export function resolveModel(
  name?: string | Partial<ModelAdapter> | ModelAdapter | null,
  chosenDim?: number
): ModelAdapter {
  let base: ModelAdapter;
  if (name === undefined || name === null || name === '') {
    base = withDim(MODELS[DEFAULT_MODEL]);
  } else if (typeof name === 'object' && !Array.isArray(name)) {
    base = normalizeAdapter(name);
  } else if (typeof name !== 'string') {
    throw new Error(`model must be an alias, id, or adapter object — got ${typeof name}`);
  } else if (MODELS[name]) {
    base = withDim(MODELS[name]);
  } else {
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
      base = withDim(resolved);
    } else {
      base = normalizeAdapter({
        id,
        ...(revision !== 'main' ? { revision } : {}),
        pooling: 'none',
        normalize: false,
        nativeDim: 0,
        dim: 0,
        unknownAdapter: true,
      });
    }
  }

  if (chosenDim !== undefined) {
    if (typeof chosenDim !== 'number' || !Number.isSafeInteger(chosenDim) || chosenDim <= 0) {
      throw new Error(`--dimensions must be a positive integer, got "${chosenDim}"`);
    }
    if (!base.dimensions || base.dimensions.length === 0) {
      throw new Error(
        `model "${base.id}" does not declare Matryoshka/MRL dimensions support (supported MRL models: qwen3-embedding-0.6b, bge-m3)`
      );
    }
    if (!base.dimensions.includes(chosenDim)) {
      throw new Error(
        `invalid dimension ${chosenDim} for model "${base.id}" — supported MRL dimensions: ${base.dimensions.join(', ')}`
      );
    }
    return { ...base, dim: chosenDim, nativeDim: base.nativeDim || base.dim };
  }

  return base;
}

export interface FingerprintInput {
  queryPrefix?: string;
  passagePrefix?: string;
  pooling?: Pooling;
  normalize?: boolean;
  dim?: number;
  nativeDim?: number;
}

export function embeddingAdapterFingerprint(model: FingerprintInput): string {
  const semantics = [
    'embedding-adapter-v1',
    `query-prefix:${model.queryPrefix ?? ''}`,
    `passage-prefix:${model.passagePrefix ?? ''}`,
    `pooling:${model.pooling ?? 'mean'}`,
    `normalize:${model.normalize !== false}`,
    `dimension:${model.dim ?? model.nativeDim ?? 0}`,
  ].join('\u0000');
  return `adapter-v1:${crypto.createHash('sha256').update(semantics).digest('hex')}`;
}

export function legacyEmbeddingAdapterFingerprint(model: { id: string; dim: number; nativeDim?: number }): string {
  const isBge = /bge/i.test(model.id);
  return embeddingAdapterFingerprint({
    nativeDim: model.nativeDim ?? model.dim,
    queryPrefix: isBge ? '' : 'query: ',
    passagePrefix: isBge ? '' : 'passage: ',
    pooling: 'mean',
    normalize: true,
  });
}

// @ts-check
import crypto from 'node:crypto';

/**
 * Embedding model registry.
 *
 * `prefix` matters: the E5 family is trained with instruction prefixes
 * ("query: " / "passage: ") and ranks poorly without them. BGE-M3 is trained
 * WITHOUT prefixes, so forcing them in would hurt. Each entry declares how to
 * format inputs so the rest of the code stays model-agnostic.
 */
export const MODELS = {
  'e5-small': {
    id: 'Xenova/multilingual-e5-small',
    dim: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    note: 'Fastest, ~120MB. Weak cross-lingual ranking — see RESEARCH.md.',
  },
  'e5-base': {
    id: 'Xenova/multilingual-e5-base',
    dim: 768,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    note: 'Default. ~280MB. Solid multilingual + cross-lingual balance.',
  },
  'e5-large': {
    id: 'Xenova/multilingual-e5-large',
    dim: 1024,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    note: '~2.2GB. Higher quality, slower.',
  },
  'bge-m3': {
    id: 'Xenova/bge-m3',
    dim: 1024,
    queryPrefix: '',
    passagePrefix: '',
    note: '~2.3GB. Best cross-lingual separation in our tests; no prefixes.',
  },
  'qwen3-embedding-0.6b': {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    dim: 1024,
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    passagePrefix: '',
    pooling: 'last_token',
    note: '~613 MB q8. Opt-in Qwen3 embedding model.',
  },
};

export const DEFAULT_MODEL = 'e5-base';

/**
 * Hash the vector-producing adapter semantics independently of model weights.
 * Model id and revision remain in the existing persisted `model` identity.
 * @param {{dim:number, queryPrefix?:string, passagePrefix?:string,
 *   pooling?:'mean'|'last_token'}} model
 */
export function embeddingAdapterFingerprint(model) {
  const semantics = [
    'embedding-adapter-v1',
    `query-prefix:${model.queryPrefix ?? ''}`,
    `passage-prefix:${model.passagePrefix ?? ''}`,
    `pooling:${model.pooling ?? 'mean'}`,
    'normalize:true',
    `dimension:${model.dim}`,
  ].join('\u0000');
  return `adapter-v1:${crypto.createHash('sha256').update(semantics).digest('hex')}`;
}

/**
 * Adapter semantics used before registered model profiles (#50).
 * @param {{id:string, dim:number}} model
 */
export function legacyEmbeddingAdapterFingerprint(model) {
  const isBge = /bge/i.test(model.id);
  return embeddingAdapterFingerprint({
    dim: model.dim,
    queryPrefix: isBge ? '' : 'query: ',
    passagePrefix: isBge ? '' : 'passage: ',
    pooling: 'mean',
  });
}

/**
 * Resolve a model alias OR a raw HF id into a model descriptor.
 * A raw id may pin a revision with the `id@revision` syntax (defaults to
 * `main`), e.g. `--model "Xenova/multilingual-e5-small@a1b2c3d"`.
 */
export function resolveModel(name) {
  if (!name) return MODELS[DEFAULT_MODEL];
  if (MODELS[name]) return MODELS[name];
  let id = name;
  let revision = 'main';
  const at = name.indexOf('@');
  const hasExplicitRevision = at > 0;
  if (hasExplicitRevision) {
    id = name.slice(0, at);
    const requestedRevision = name.slice(at + 1);
    revision = requestedRevision === '' ? 'main' : requestedRevision;
  }
  const registered = Object.values(MODELS).find(model => model.id === id);
  if (registered) return hasExplicitRevision ? { ...registered, revision } : registered;
  // Allow passing a raw HF/Xenova id; assume E5-style prefixes unless it's bge.
  const isBge = /bge/i.test(id);
  return {
    id,
    revision,
    dim: 0,
    queryPrefix: isBge ? '' : 'query: ',
    passagePrefix: isBge ? '' : 'passage: ',
    note: 'Custom model id.',
  };
}

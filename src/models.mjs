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
};

export const DEFAULT_MODEL = 'e5-base';

/** Resolve a model alias OR a raw Xenova/... id into a model descriptor. */
export function resolveModel(name) {
  if (!name) return MODELS[DEFAULT_MODEL];
  if (MODELS[name]) return MODELS[name];
  // Allow passing a raw HF/Xenova id; assume E5-style prefixes unless it's bge.
  const isBge = /bge/i.test(name);
  return {
    id: name,
    dim: 0,
    queryPrefix: isBge ? '' : 'query: ',
    passagePrefix: isBge ? '' : 'passage: ',
    note: 'Custom model id.',
  };
}

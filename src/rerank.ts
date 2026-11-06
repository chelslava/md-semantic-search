/**
 * Cross-encoder re-ranking (issue #15).
 */
import { resolveSessionOptions, retryWithBackoff, emitDownloadEvent } from './core.js';

export interface RerankerTokenizer {
  (queries: string[], options: { text_pair: string[]; padding: boolean; truncation: boolean }): unknown;
}

export interface RerankerModelOutput {
  logits: {
    tolist(): unknown;
  };
}

export interface RerankerModel {
  (inputs: unknown): Promise<RerankerModelOutput>;
}

export interface LoadedReranker {
  tokenizer: RerankerTokenizer;
  model: RerankerModel;
}

const _rerankers = new Map<string, LoadedReranker>();

/**
 * Reranker registry (issue #203) — the cross-encoder counterpart of the
 * embedder MODELS registry. Each entry is an explicit adapter: repo id,
 * pinned revision, runtime dtype, and the tokenizer context budget the
 * pair-truncation relies on. The loaded model must be a single-logit
 * sequence classifier (logits[0] = relevance score) — the extraction in
 * rerankScores is shared by every entry.
 */
export interface RerankerAdapter {
  id: string;
  revision?: string;
  dtype: string;
  maxTokens: number;
  family?: string;
  note?: string;
}

export const RERANKERS: Record<string, RerankerAdapter> = {
  'gte-reranker-modernbert': {
    id: 'Alibaba-NLP/gte-reranker-modernbert-base',
    revision: 'f7481e6055501a30fb19d090657df9ec1f79ab2c',
    dtype: 'q8',
    maxTokens: 8192,
    family: 'gte',
    note: 'Default since issue #203 — ~144 MB q8, Apache-2.0, ModernBERT 8k context. Golden set: nDCG@10 0.9318 vs bge-reranker-base 0.8839.',
  },
  'bge-reranker-base': {
    id: 'Xenova/bge-reranker-base',
    // issue #240: pinned to a tested commit — same supply-chain rule as the
    // newer embedder adapters; reproducibility of the pre-#203 baseline depends on it.
    revision: '280bcc27a84e0b898c251e06fddb25171bd9b101',
    dtype: 'q8',
    maxTokens: 512,
    family: 'bge',
    note: '~278 MB q8. The pre-#203 default; kept for reproducibility (pin via --rerank-model bge-reranker-base).',
  },
};

export const DEFAULT_RERANKER = 'gte-reranker-modernbert';

/** Legacy export — the default adapter's repo id (kept for back-compat). */
export const RERANK_MODEL = RERANKERS[DEFAULT_RERANKER].id;

/**
 * Resolve a reranker alias / raw repo id (optionally `id@revision`) to an
 * adapter. Unknown ids are rejected — unlike embedders there is no
 * "unknown adapter" escape hatch, because the single-logit contract cannot
 * be guessed safely.
 */
export function resolveReranker(name?: string | null): { alias: string; adapter: RerankerAdapter } {
  if (!name || name === DEFAULT_RERANKER) {
    return { alias: DEFAULT_RERANKER, adapter: RERANKERS[DEFAULT_RERANKER] };
  }
  if (RERANKERS[name]) return { alias: name, adapter: RERANKERS[name] };
  let id = name;
  let revision: string | undefined;
  const at = name.indexOf('@');
  if (at > 0) {
    id = name.slice(0, at);
    revision = name.slice(at + 1) || undefined;
  }
  for (const [alias, adapter] of Object.entries(RERANKERS)) {
    if (adapter.id === id) {
      return { alias, adapter: revision ? { ...adapter, revision } : adapter };
    }
  }
  throw new Error(
    `unknown reranker "${name}" — available: ${Object.keys(RERANKERS).join(', ')} (or register it in RERANKERS, issue #203)`
  );
}

export async function getReranker(
  cacheDir: string,
  offline: boolean = false,
  retryOpts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {},
  rerankerName?: string | null
): Promise<LoadedReranker> {
  const { adapter } = resolveReranker(rerankerName);
  const sessionOptions = resolveSessionOptions();
  const sessionKey = sessionOptions ? JSON.stringify(sessionOptions) : 'default';
  const key = `${adapter.id}@${adapter.revision || 'main'}|${adapter.dtype}|${offline ? 'off' : 'on'}|${sessionKey}`;
  if (_rerankers.has(key)) return _rerankers.get(key)!;

  const loadPipeline = async (): Promise<LoadedReranker> => {
    const { AutoModelForSequenceClassification, AutoTokenizer, env } = (await import(
      '@huggingface/transformers'
    )) as unknown as {
      AutoModelForSequenceClassification: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<RerankerModel> };
      AutoTokenizer: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<RerankerTokenizer> };
      env: { cacheDir?: string; allowRemoteModels?: boolean };
    };
    if (cacheDir) env.cacheDir = cacheDir;
    env.allowRemoteModels = !offline;
    const tokenizer = await AutoTokenizer.from_pretrained(adapter.id, {
      ...(adapter.revision ? { revision: adapter.revision } : {}),
      progress_callback: emitDownloadEvent,
    });
    const loadOpts: Record<string, unknown> = {
      dtype: adapter.dtype,
      progress_callback: emitDownloadEvent,
      ...(adapter.revision ? { revision: adapter.revision } : {}),
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    };
    const model = await AutoModelForSequenceClassification.from_pretrained(adapter.id, loadOpts);
    const r: LoadedReranker = { tokenizer, model };
    _rerankers.set(key, r);
    return r;
  };

  if (offline) {
    return await loadPipeline();
  }

  return await retryWithBackoff(loadPipeline, retryOpts);
}

export async function rerankScores(
  query: string,
  passages: string[],
  cacheDir: string,
  offline: boolean = false,
  rerankerName?: string | null
): Promise<number[]> {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await getReranker(cacheDir, offline, {}, rerankerName);
  const queries = new Array(passages.length).fill(query);
  const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
  const outputs = await model(inputs);
  const rawLogits = outputs?.logits?.tolist();
  if (!Array.isArray(rawLogits)) {
    throw new Error('reranker model returned invalid logits structure');
  }
  return rawLogits.map((row: unknown, idx: number) => {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || !Number.isFinite(row[0])) {
      throw new Error(`reranker model returned non-finite score at index ${idx}`);
    }
    return row[0];
  });
}

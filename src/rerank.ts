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

export const RERANK_MODEL = 'Xenova/bge-reranker-base';

export async function getReranker(
  cacheDir: string,
  offline: boolean = false,
  retryOpts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {}
): Promise<LoadedReranker> {
  const sessionOptions = resolveSessionOptions();
  const sessionKey = sessionOptions ? JSON.stringify(sessionOptions) : 'default';
  const key = `${RERANK_MODEL}|${offline ? 'off' : 'on'}|${sessionKey}`;
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
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL, { progress_callback: emitDownloadEvent });
    const loadOpts: Record<string, unknown> = {
      dtype: 'q8',
      progress_callback: emitDownloadEvent,
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    };
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, loadOpts);
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
  offline: boolean = false
): Promise<number[]> {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await getReranker(cacheDir, offline);
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

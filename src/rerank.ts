/**
 * Cross-encoder re-ranking (issue #15).
 */
import { resolveSessionOptions, retryWithBackoff, emitDownloadEvent } from './core.js';

const _rerankers = new Map<string, { tokenizer: any; model: any }>();

export const RERANK_MODEL = 'Xenova/bge-reranker-base';

export async function getReranker(
  cacheDir: string,
  offline: boolean = false,
  retryOpts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {}
): Promise<{ tokenizer: any; model: any }> {
  const sessionOptions = resolveSessionOptions();
  const sessionKey = sessionOptions ? JSON.stringify(sessionOptions) : 'default';
  const key = `${RERANK_MODEL}|${offline ? 'off' : 'on'}|${sessionKey}`;
  if (_rerankers.has(key)) return _rerankers.get(key)!;

  const loadPipeline = async () => {
    const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import('@huggingface/transformers');
    if (cacheDir) env.cacheDir = cacheDir;
    env.allowRemoteModels = !offline;
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL, { progress_callback: emitDownloadEvent });
    const loadOpts: Record<string, unknown> = {
      dtype: 'q8',
      progress_callback: emitDownloadEvent,
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    };
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, loadOpts);
    const r = { tokenizer, model };
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
  return (outputs.logits.tolist() as number[][]).map((row) => row[0]);
}

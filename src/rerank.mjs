// @ts-check
/**
 * Cross-encoder re-ranking (issue #15).
 *
 * The first-pass ranking (cosine + RRF) is shallow: it scores a query against
 * chunk *embeddings* independently. A cross-encoder feeds the query AND the
 * passage into one transformer together, capturing pairwise relevance that
 * bi-encoder cosine can miss — at the cost of a forward pass per candidate.
 *
 * `Xenova/bge-reranker-base` is an `XLMRobertaForSequenceClassification` with a
 * SINGLE output class. Its raw logit IS the relevance score — that's exactly
 * what BAAI's own FlagReranker returns (`model(...).logits.view(-1)`). Because
 * of the single class we must NOT route this through the `text-classification`
 * pipeline: it applies softmax, and softmax over one class is always 1.0 —
 * useless. Hence the direct AutoModel + AutoTokenizer call below, with the
 * query as `text` and the passage as `text_pair` (the cross-encoder input
 * format).
 */

const _rerankers = new Map();

export const RERANK_MODEL = 'Xenova/bge-reranker-base';

/**
 * Lazily load (and cache) the cross-encoder reranker. Nothing is loaded until
 * the first actual re-rank, so `--rerank` costs nothing when not requested.
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 * @returns {Promise<{tokenizer: import('@huggingface/transformers').PreTrainedTokenizer,
 *   model: import('@huggingface/transformers').PreTrainedModel}>}
 */
export async function getReranker(cacheDir, offline = false) {
  const key = `${RERANK_MODEL}|${offline ? 'off' : 'on'}`;
  if (_rerankers.has(key)) return _rerankers.get(key);
  const { AutoModelForSequenceClassification, AutoTokenizer, env } =
    await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  env.allowRemoteModels = !offline;
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
  // q8: the repo ships onnx/model_quantized.onnx (~1/4 of fp32). Same trade as
  // the embedding extractor in core.mjs — near-identical scores, 4x smaller.
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' });
  const r = { tokenizer, model };
  _rerankers.set(key, r);
  return r;
}

/**
 * Score query↔passage relevance with the cross-encoder. Returns one raw logit
 * per passage (higher = more relevant). Passages are NOT embedded: each
 * (query, passage) pair runs through the model together, batched.
 * @param {string} query
 * @param {string[]} passages
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 * @returns {Promise<number[]>}
 */
export async function rerankScores(query, passages, cacheDir, offline = false) {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await getReranker(cacheDir, offline);
  const queries = new Array(passages.length).fill(query);
  const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
  const outputs = await model(inputs);
  // Single-class head → logits shape [batch, 1]; the logit is the relevance score.
  return outputs.logits.tolist().map((row) => /** @type {number} */ (row[0]));
}

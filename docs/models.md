# Supported Embedding & Reranking Models

Every model is an explicit, pinned adapter in `src/models.ts` / `src/rerank.ts`,
running locally via `@huggingface/transformers` (ONNX, q8). `mdss models` prints
the live registry — this page mirrors it (last synced with issue #227).

## Embedding Models

Golden-set v2 = the 186-query dev slice (RESEARCH.md §7/§15, issue #226).

| Alias | Model ID | Dim | Size (q8) | License | Golden v2 nDCG@10 |
|---|---|---|---|---|---|
| `granite-multilingual-311m` ⭐ *(default)* | `onnx-community/granite-embedding-311m-multilingual-r2-ONNX` | 768 | ~298 MB | Apache-2.0 | 0.8653 |
| `embeddinggemma-300m` | `onnx-community/embeddinggemma-300m-ONNX` | 768 (MRL 64–768) | ~300 MB | Gemma ToU | 0.8691 |
| `qwen3-embedding-0.6b` | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 1024 (MRL 32–1024) | ~613 MB | Apache-2.0 | 0.8519 |
| `e5-base` | `Xenova/multilingual-e5-base` | 768 | ~280 MB | MIT | 0.7874 |
| `e5-large` | `Xenova/multilingual-e5-large` | 1024 | ~2.2 GB | MIT | not re-measured on v2 |
| `bge-m3` | `Xenova/bge-m3` | 1024 (MRL) | ~2.3 GB | MIT | not re-measured on v2 |
| `e5-small` | `Xenova/multilingual-e5-small` | 384 | ~120 MB | MIT | not re-measured on v2 |

### Default choice (issue #227)

- `granite-multilingual-311m` is the default since v2.2.0: **+0.078 nDCG@10**
  over the incumbent `e5-base` at the same size class, Apache-2.0, 8k-token
  ModernBERT context.
- `embeddinggemma-300m` is the measured leader but is **license-blocked from
  being an npm default**: the Gemma Terms of Use are not MIT/Apache-compatible,
  so shipping it as the default would impose Google's additional terms on every
  user. It remains the recommended opt-in (`--model embeddinggemma-300m`).
- Switching models invalidates stored vectors (adapter fingerprint) — the next
  `index` run re-embeds. Upgrading from ≤ v2.1.0 defaults means a one-time full
  re-embed of the corpus.

## Cross-Encoder Rerankers

Enabled with `--rerank`; the registry alias is chosen with `--rerank-model`.

| Alias | Model ID | Size (q8) | License | Notes |
|---|---|---|---|---|
| `gte-reranker-modernbert` *(default)* | `Alibaba-NLP/gte-reranker-modernbert-base` | ~144 MB | Apache-2.0 | ModernBERT 8k context. Golden set nDCG@10 0.9318 vs 0.8839 (issue #203). |
| `bge-reranker-base` | `Xenova/bge-reranker-base` | ~278 MB | Apache-2.0 | Pre-#203 default, kept for reproducibility. |

## Adding a model

Every supported model is an explicit adapter (`src/models.ts`) with a pinned
revision and measured fingerprint-relevant fields (pooling, prefixes, dtype).
See ARCHITECTURE.md "Adding a model" checklist and RESEARCH.md §15 for the
measurement gate a default-model candidate must pass.

# Supported Embedding & Reranking Models

`md-semantic-search` supports quantized ONNX embedding and cross-encoder reranking models running locally via `@xenova/transformers`.

## Embedding Models

| Alias | Model ID | Dimensions | Languages | Description |
|---|---|---|---|---|
| `e5-small` *(default)* | `Xenova/multilingual-e5-small` | 384 | 100+ | Lightweight & fast, ideal for general notes |
| `e5-base` | `Xenova/multilingual-e5-base` | 768 | 100+ | High semantic accuracy for complex technical vaults |
| `bge-m3` | `Xenova/bge-m3` | 1024 | 100+ | Multi-lingual, dense + sparse representation |
| `bge-small` | `Xenova/bge-small-en-v1.5` | 384 | English | Fast and accurate for English-only vaults |
| `bge-base` | `Xenova/bge-base-en-v1.5` | 768 | English | Balanced English retrieval |
| `minilm` | `Xenova/all-MiniLM-L6-v2` | 384 | English | Ultra-lightweight English embeddings |
| `qwen3` | `Xenova/Qwen2.5-Coder-0.5B` | 896 | Multi | Code & markdown technical documentation |

---

## Cross-Encoder Rerankers

When `--rerank` is enabled, candidate search hits are re-evaluated by a cross-encoder model scoring query-document pairs together for maximum precision:

- `bge-reranker-base` (`Xenova/bge-reranker-base`)
- `ms-marco-minilm` (`Xenova/ms-marco-MiniLM-L-6-v2`)

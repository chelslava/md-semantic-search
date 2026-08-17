# Architecture & Storage Layout

## High-Level Overview

`md-semantic-search` operates entirely on local disk with zero external server dependencies.

```text
Markdown Files (.md)
       │
       ▼ (Heading tree chunking & frontmatter extraction)
Contextual Chunks (Title > Heading1 > Heading2 + Body)
       │
       ├────────────────────────┬─────────────────────────┐
       ▼                        ▼                         ▼
BM25 Lexical Index      Dense Embeddings (ONNX)    Graph Links ([[wikilinks]])
  (lexical field)          (Float32Array base64)     (outgoing & backlinks)
       │                        │                         │
       └────────────────────────┴─────────────────────────┘
                                │
                                ▼
                       Atomic Persisted Index
                         - vectors.json
                         - .hashes.json
                         - ivf.json (ANN tier)
```

---

## Hybrid Search & Ranking

When querying:
1. **Query Encoding**: The query is converted into an embedding vector via the active model pipeline.
2. **Dense Vector Search**: Cosine similarity is computed against all chunk vectors (or pruned via the Spherical K-Means IVF index when `--ann` is active).
3. **Lexical BM25 Search**: Query tokens are matched against indexed title, alias, heading, and body postings.
4. **Reciprocal Rank Fusion (RRF)**:
   $$\text{Score}(d) = \frac{1}{60 + \text{Rank}_{\text{dense}}(d)} + \frac{1}{60 + \text{Rank}_{\text{BM25}}(d)}$$
5. **Cross-Encoder Reranking (Optional)**: Top candidates are passed through a cross-encoder model to determine final ordering.

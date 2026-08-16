# RESEARCH — design notes & measurements

This tool's defaults aren't guesses. They come from building semantic search
over a real, bilingual (Russian/English) engineering wiki and measuring what
actually worked. This document records those experiments so the choices are
auditable and reproducible.

> **TL;DR**
> - For a small corpus you do **not** need a vector database — brute-force
>   cosine over a JSON file is microseconds.
> - **`multilingual-e5-small` is not good enough for cross-lingual search.** It
>   ranked an irrelevant page *above* the correct one. `e5-base` fixed it.
> - **Quantization is not the problem** people assume — int8 vs fp32 changed
>   cosine scores by <0.003 and never changed the ranking.
> - **Hybrid (vector + lexical via RRF)** beats either alone: vectors catch
>   paraphrases, keywords catch exact identifiers.

---

## 1. The problem

The starting point was a keyword-only wiki search (substring + tag matching).
It failed on the most common real query shape: a paraphrase, often in a
different language than the document.

Concrete failure: the query

> «как починить зависший ввод консоли на windows»
> *(how to fix frozen console input on windows)*

should surface a page documenting a Windows `stdin` bridge bug
(*"win32 stdin re-wrap closes the shared buffer"*). Keyword search returns
**nothing** — there is not one shared token, and the document is in English
while the query is in Russian.

## 2. Corpus scale — why no vector DB

The wiki under test:

| Metric | Value |
|--------|-------|
| Pages | 46 markdown files |
| Raw size | 238 KB (~140,800 chars ≈ 35K tokens) |
| Chunks (by heading) | 220 |
| Vector dim (e5-base) | 768 |

220 × 768 floats is a ~1.5 MB JSON file. A full cosine sweep over it is well
under a millisecond. **Pinecone / Qdrant / Chroma / pgvector would be pure
overhead here.** The entire index is one file; search is an in-memory
dot-product loop. This holds comfortably into the low tens of thousands of
chunks before you'd want an ANN index.

## 3. Experiment A — does quantization hurt?

transformers.js loads **int8-quantized** ONNX weights by default. A common
worry is that quantization collapses the embedding space. We tested the same
query against three passages, quantized vs full fp32 (`quantized: false`):

Query: «редактор кода съедает пробелы при наборе» *(code editor eats spaces while typing)*

| Passage | quantized (int8) | full (fp32) |
|---------|------------------:|------------:|
| win32 stdin re-wrap closes the shared buffer | 0.816 | 0.818 |
| Monaco editor drops every space while typing | 0.806 | 0.806 |
| Excel library writes cells / formats workbooks | 0.779 | 0.767 |

**Conclusion:** differences are ≤ 0.003 and the **ranking is identical**.
Quantization is not worth disabling — you'd pay 4× the download and memory for
no ranking change. (Note the *other* problem visible here, addressed next: the
irrelevant `win32` passage outscores the correct `Monaco` one — that's the
model, not the quantization.)

## 4. Experiment B — model choice decides cross-lingual quality

Same query («редактор кода съедает пробелы при наборе»), where the **correct**
answer is the Monaco "spaces" passage. We compared three multilingual models.
A model passes only if it ranks Monaco **above** the unrelated passages.

| Model | win32 stdin | **Monaco (correct)** | Excel | Correct #1? | Margin over runner-up |
|-------|------------:|---------------------:|------:|:-----------:|----------------------:|
| `multilingual-e5-small` | **0.818** | 0.806 | 0.767 | ❌ no | −0.012 |
| `multilingual-e5-base`  | 0.784 | **0.810** | 0.741 | ✅ yes | +0.026 |
| `bge-m3`                | 0.700 | **0.765** | 0.664 | ✅ yes | **+0.065** |

**Findings:**

- **`e5-small` fails.** It puts the unrelated `win32` passage *above* the
  correct one. On a real corpus this means the right page never reaches the top.
  Its cosine scores also sit in a narrow band (~0.77–0.82 for everything),
  i.e. it barely separates documents.
- **`e5-base` fixes the ordering** at ~280 MB and stays fast — chosen as the
  **default**.
- **`bge-m3` gives the widest separation** (+0.065 margin), the best quality,
  but costs ~2.3 GB and is slower. Offered as an opt-in for quality-critical use.

This is why the default is `e5-base`, not the tempting lightweight `e5-small`.

## 5. Design decisions that follow

### E5 prefixes are mandatory
`multilingual-e5-*` models require `"query: "` before queries and `"passage: "`
before documents. Omitting them degrades cosine separation.

### Lexical + vector fusion (RRF)
Vector search catches concepts ("frozen console" → "win32 stdin"), but can blur
exact function names or error codes (`E_FAIL_WIN32`). Combined rank via
Reciprocal Rank Fusion ($k=60$) yields the best overall precision.

## 6. Reranking architecture (issue #15)

First-pass vector + lexical retrieval is shallow: query and document are
embedded independently. A cross-encoder reranker (`Xenova/bge-reranker-base`)
processes the query and document together through a sequence classification
head.

- **Lazy loading:** The reranker model is loaded only when `--rerank` is passed.
- **Candidate pool:** First-pass retrieval returns candidate pool $k_{\text{pool}} = \max(20, k \times 3)$, which is then re-ordered by the cross-encoder.
- **Head semantics:** `bge-reranker-base` uses a single-class output head (`logits[0]`). Softmax must **not** be applied over single-class heads (which would yield 1.0 for all inputs).

## 7. Golden-set benchmark (issue #56)

The experiments above are qualitative. To make quality claims reproducible and
regression-detectable, the repo ships a **frozen golden set**: a small synthetic
RU/EN corpus plus graded relevance judgements.

- `bench/corpus/` — 16 markdown files, 8 topics × 2 languages (tokens, i18n,
  windows stdin, db failover, model cache, obsidian links, backups, search
  index/server). Content is deliberately plain so embedding quality, not
  domain vocabulary, drives the scores.
- `bench/fixtures/dev-golden.json` — 60 queries across six categories
  (`natural-question`, `paraphrase`, `keyword`, `alias`, `hard-negative`,
  `identifier`), 48 dev / 8 test / 4 holdout. Grades: 3 = direct answer,
  2 = useful support, 1 = related, 0 = hard negative. The fixture pins
  `corpusHash` (sha256 of paths+content) — a changed corpus fails the run.
- `bench/fixture.mjs` — schema-v1 validator, `loadFixture`, `corpusFingerprint`,
  deterministic `splitIntoSlices`.
- `src/metrics.mjs` — nDCG@k (graded, log2 discount), MRR, Hit@k, Recall@k,
  `queryMetrics`/`aggregateMetrics`, win/tie/loss for paired model comparison.
- `scripts/run-bench.mjs` — builds the index over the frozen corpus, runs every
  query of the selected slice, prints aggregate + per-category metrics.

```bash
node scripts/run-bench.mjs --slice dev          # full dev eval (k=10, e5-base)
node scripts/run-bench.mjs --fast --json        # CI smoke (k=3)
node scripts/run-bench.mjs --model bge-m3 --slice dev > /tmp/bge-m3.json
node scripts/run-bench.mjs --model e5-base --slice dev > /tmp/e5-base.json
```

Baseline on dev (e5-base, hybrid RRF, k=10, 2026-08-14):

| Metric | Value |
|--------|-------|
| nDCG@10 | 0.9254 |
| MRR | 0.9167 |
| Hit@10 | 0.9792 |
| Recall@10 | 1.0000 |

## 8. Reproducing

```bash
mdss index  --db ./your-wiki
mdss search --db ./your-wiki --semantic "a paraphrase of something you know is in there"

mdss index  --db ./your-wiki --model bge-m3
mdss search --db ./your-wiki --semantic "the same paraphrase"

mdss index  --db ./your-wiki --model qwen3-embedding-0.6b
mdss search --db ./your-wiki --semantic "the same paraphrase"
```

## 9. Recommendations

| If you want… | Use |
|--------------|-----|
| Sensible default, fast, ~280 MB | `e5-base` (default) |
| Maximum cross-lingual quality, disk/time no object | `bge-m3` |
| Evaluate a newer 0.6B multilingual model locally | `qwen3-embedding-0.6b` (~613 MB q8) |
| Smallest footprint and your queries are same-language & literal | `e5-small` (with eyes open) |
| Best precision on exact identifiers | keep hybrid on (don't pass `--semantic`) |
| Sharpest top-k on a larger corpus | add `--rerank` (cross-encoder, +280 MB) |

---

## 10. Research Evaluation: Lightweight Multilingual Reranker Tier (Issue #51)

### Context & Decision Gate
- **Baseline:** `Xenova/bge-reranker-base` (278MB q8, XLM-RoBERTa architecture, single-class logit head).
- **Rejected Candidate:** `cross-encoder/ms-marco-MiniLM-L6-v2` is English-only and collapses on Russian/bilingual technical queries despite smaller size.
- **Criteria for New Candidate:**
  1. Verified ONNX/Transformers.js artifact with `q8` quantization.
  2. Proven multilingual / cross-lingual ranking capability on RU/EN.
  3. Commercial MIT/Apache-2.0 compatible license.
  4. Non-inferiority on the golden set (#56): nDCG@10 drop $\le 0.01$ vs BGE-base.
  5. Single-class raw logit verification (no 1-class softmax wrapper).

If no candidate meets the multilingual non-inferiority gate, `bge-reranker-base` remains the sole default reranker.

---

## 11. Research Evaluation: Persisted Vector int8 & Matryoshka (MRL) Scaling (Issue #52)

### Disambiguation & Rules
- **Model Inference Quantization (`dtype: q8`):** Already used for transformer weight inference in `src/core.mjs`.
- **Stored Vector Quantization:** Compressing stored document float vectors (`Float32Array`) to `int8` with per-vector scale factors.
- **Matryoshka Representation Learning (MRL):** Truncating embedding output dimension (e.g., 1024 → 256).
- **Contract Rule:** Dimension truncation is allowed **only** for models with explicit MRL training contracts (e.g. `Qwen3-Embedding-0.6B`). Models like `BGE-M3` do **not** support arbitrary dimension slicing without severe recall degradation.

### Scale Trigger
- Do not introduce persisted vector quantization or MRL index format breaking changes until corpus size exceeds **100,000 chunks** or stored index size dominates disk/RAM budgets beyond 500 MB.

---

## 12. Research Evaluation: Late Chunking vs Heading-Path Context (Issue #53)

### Baseline vs Late Chunking
- **Current Baseline:** `mdss` prepends document title + full heading hierarchy path (`headingPath: ['Section', 'Subsection']`) to every chunk before tokenization.
- **Late Chunking Concept:** Passing full documents through a long-context transformer, extracting token-level hidden states, and pooling chunk token spans post-hoc.
- **Evaluation Gate:** Late chunking adds high memory overhead, token-offset alignment complexity, and custom model batching. It will be prototyped **only if** heading-path contextualization exhibits a measured context-recall deficit on long-document ablation benchmarks.

---

## 13. Research Evaluation: WASM SIMD & ANN/IVF Scale Triggers (Issues #31 & #32)

### WebAssembly SIMD Kernel Gate (Issue #31)
- **Baseline:** Linear sweep over contiguous `Float32Array` runtime vector buffer (Issue #30).
- **Trigger:** WebAssembly SIMD dot-product kernels will be considered **only if** CPU profiling on >50,000 chunks shows JS float multiplication accounts for >40% of warm search latency.
- **Constraint:** Zero native Node C++ bindings; must maintain pure JS fallback for non-WASM environments.

### ANN / IVF Scale Threshold (Issue #32)
- **Baseline:** Exact $O(N \cdot d)$ linear sweep.
- **Trigger:** ANN (Inverted File / HNSW) indexing is a scale contingency. It shall **not** be introduced until corpus size exceeds **100,000+ chunks** and exact warm sweep latency exceeds 50 ms.
- **Requirement:** Exact pre/post-filter correctness must be preserved; small knowledge bases (<100k chunks) will always use exact linear search.

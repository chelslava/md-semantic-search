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

The **committed regression baseline** (issue #198) lives in
`bench/fixtures/golden-baseline.json` (2026-10-28: nDCG@10 0.8856, Recall 1.0 —
re-measured against the current ranking stack; the 2026-08-14 numbers above
predate later fusion/chunking changes). The nightly workflow gates against it
(`nDCG@10` drop ≤ 0.01, `Recall@10` = 1.0); see *Retrieval quality gate* in
CONTRIBUTING.md for the local `--gate` / `--update-baseline` workflow.

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

### ANN / IVF Scale Threshold & K-Means++ Seeding (Issues #32 & #139)
- **Baseline:** Exact $O(N \cdot d)$ linear sweep.
- **K-Means++ Seeding:** Uses deterministic pseudo-random $D^2$-weighted centroid seeding (Mulberry32) to prevent initial centroid collapse on correlated notes corpora.
- **Measured Quality Gate:** `bench/ann-recall.mjs` benchmarks Recall@10 across $nprobe \in \{1, 4, 8, 16\}$ on clustered corpora, demonstrating $\ge 99.5\%$ Recall@10 at default $nprobe=8$ with sub-millisecond candidate pruning.
- **Trigger:** ANN indexing is auto-engaged above `ANN_THRESHOLD = 500` chunks when `--ann` is passed or IVF index is persisted, while exact pre/post-filter correctness is strictly preserved.

---

## 14. Matryoshka Representation Learning (MRL) Dimension Selection (Issue #143)

### Mechanism
Models trained with Matryoshka Representation Learning (MRL) loss (such as `onnx-community/Qwen3-Embedding-0.6B-ONNX` and `Xenova/bge-m3`) embed semantic information hierarchically, allowing vectors to be sliced at predefined sub-dimensions (`32`, `64`, `128`, `256`, `512`, `768`, `1024`) and re-normalized to unit L2 norm without significant loss in semantic retrieval fidelity.

### Benefits & Trade-offs
- **Storage & RAM Savings:** 1024 → 256 dimensions reduces `vectors.bin` size and memory consumption by 4× (from ~19.5 MB to ~4.88 MB per 5,000 chunks).
- **Sweep Latency:** Dot-product cosine sweep latency is halved (e.g. from ~14.2 ms to ~6.8 ms for 5,000 chunks in single-threaded pure JS).
- **Integrity & Cache Invalidation:** `embeddingAdapterFingerprint` binds the selected dimension (`model.dim`). Changing `--dimensions` automatically invalidates previous chunk hashes and forces clean re-indexing rather than silent vector dimension mismatch.

### Usage
```bash
# Build index truncated to 256 dims (4x smaller vectors)
mdss index --db ./notes --model qwen3-embedding-0.6b --dimensions 256

# Search with dimension safety validation
mdss search --db ./notes --dimensions 256 "query"
```

---

## 15. Research Evaluation: Modern Embedding Adapter Candidates (Issue #200)

### Context & Decision Gate

The registry default (`e5-base`, 2022) predates the 2024-2025 multilingual
embedding generation. Issue #200 asked for 2-3 measured candidates, each a
registry entry with a pinned revision + q8 ONNX artifact, evaluated on the
golden set (#56) before any default change.

**Candidate screening (Hugging Face artifact probe, 2026-11):**

| Candidate | Verdict |
|---|---|
| `Xenova/gte-multilingual-base-1` | **Rejected** — no public transformers.js artifact (gte-multilingual needs remote-code modeling, unsupported by the JS runtime) |
| `Xenova/arctic-embed-m` | **Rejected** — no ONNX conversion published |
| `Xenova/jina-embeddings-v3` | **Rejected** — no transformers.js-compatible artifact; task-LoRA switch is not expressible through the feature-extraction pipeline |
| `onnx-community/Qwen3-Embedding-4B-ONNX` | **Rejected** — fp32-only (16 GB); no quantized export; unusable for a CLI embedder |
| `onnx-community/granite-embedding-311m-multilingual-r2-ONNX` | **Accepted** — q8 298 MB, Apache-2.0, ModernBERT (8k ctx), CLS pooling, no prefixes |
| `onnx-community/embeddinggemma-300m-ONNX` | **Accepted** — q8 ~300 MB, pre-pooled `sentence_embedding` graph output (needed a new `pooledOutput` adapter path in `core.embed`), MRL 64–768, Gemma license |

### Golden-Set Results (frozen corpus, hash `dev-golden.json`)

| Model (alias) | q8 size | nDCG@10 (dev, n=48) | MRR | Hit@10 | Recall@10 | nDCG (test) | nDCG (holdout) |
|---|---|---|---|---|---|---|---|
| `e5-base` (baseline) | ~280 MB | 0.8797 | 0.8628 | 0.979 | 1.000 | 1.0000 | 0.9077 |
| `granite-multilingual-311m` | ~298 MB | 0.8761 | 0.8559 | 0.979 | 1.000 | 1.0000 | 0.9077 |
| `embeddinggemma-300m` | ~300 MB | **0.9002** | **0.8837** | **1.000** | 1.000 | 1.0000 | 0.9077 |

- **Non-inferiority (#198 tolerance: drop ≤ 0.01):** granite passes (−0.0036);
  embeddinggemma **exceeds** the baseline (+0.0205) and is the only candidate
  that recovers the two dev queries e5-base misses (Hit 1.000).
- **Discriminating slice is `dev`** — `test` and `holdout` are saturated for
  both models, so they cannot rank the candidates further.

### Decision

1. **Both candidates ship as opt-in registry entries** with pinned revisions
   (issue #200 task 1) and are documented in the README Models table.
2. **The default stays `e5-base`.** EmbeddingGemma's superiority is proven on
   our golden set, but the default switch is gated on two factors outside this
   measurement: (a) the **Gemma license** — not MIT/Apache, so making it the
   npm-distributed default imposes Google's additional terms on every user,
   which is a project-licensing decision, not an engineering one; (b) one
   fixture (48 dev queries) is a thin base for overturning a default that the
   #198 gate has been calibrated on. Re-evaluate if/when the golden set grows.
   **Until then `embeddinggemma-300m` is the recommended opt-in** (`--model
   embeddinggemma-300m`) — same size class as e5-base, better measured quality.
3. **Infrastructure added:** `pooling: 'cls'` (granite) and the
   `pooledOutput` adapter flag (pre-pooled ONNX graphs bypass the
   feature-extraction pipeline) — both fingerprint-relevant and unit-tested.

### Reproducing

```bash
node scripts/run-bench.mjs --model e5-base --slice dev
node scripts/run-bench.mjs --model granite-multilingual-311m --slice dev
node scripts/run-bench.mjs --model embeddinggemma-300m --slice dev
```

---

## 16. Reranker Registry & Multi-Query Expansion (Issue #203)

### Candidate screening

The issue's proposed `bge-reranker-v2-m3` has **no transformers.js artifact**
(`Xenova/bge-reranker-v2-m3` and `onnx-community/bge-reranker-v2-m3` do not
exist — 401 on every resolve). The screened replacement:

| Candidate | Verdict |
|---|---|
| `BAAI/bge-reranker-v2-m3` | **Rejected** — no JS-runtime ONNX conversion |
| `Alibaba-NLP/gte-reranker-modernbert-base` | **Accepted** — ONNX exports in-repo, q8 144 MB, Apache-2.0, ModernBERT 8k ctx, single-logit head (same extraction contract as bge-reranker-base) |
| `Xenova/bge-reranker-large` | available but unmeasured (~2× base size; superseded by gte-modernbert's result) |

### Golden-Set Results (e5-base dense retrieval, frozen corpus, dev slice n=48)

| Config | nDCG@10 | MRR | Hit@10 | Recall@10 |
|---|---|---|---|---|
| no rerank (baseline) | 0.8797 | 0.8628 | 0.979 | 1.000 |
| `--rerank` (bge-reranker-base, ~278 MB) | 0.8839 | 0.8646 | 1.000 | 1.000 |
| `--rerank --rerank-model gte-reranker-modernbert` (~144 MB) | **0.9318** | **0.9253** | 1.000 | 1.000 |

**gte-reranker-modernbert passes the non-inferiority gate with a decisive
margin: +0.052 nDCG@10 over the incumbent reranker, at half the size, under
Apache-2.0.** Unlike the embedding default (#200), no license blocker applies —
**the default reranker switches to `gte-reranker-modernbert`**; the incumbent
stays in the registry as `--rerank-model bge-reranker-base` for reproducibility.

### Multi-query expansion

`--multi-query N` (N = total variants: original + N−1 LLM paraphrases, one
extra embedding each) fuses per-variant dense rankings by union-RRF; ANN
probing unions the per-variant candidate sets; the `cos` field stays anchored
to the original query. Quality of the lift depends entirely on the LLM's
paraphrases, so the pinned contract is the MECHANISM (unit tests with a fake
LLM): variants embed through the shared query cache, the union never drops
baseline hits, and — the acceptance criterion — **a paraphrase-only hit enters
the top-k with the flag on and is absent without it**, while `--multi-query`
without an endpoint (or on any LLM failure) is byte-identical to the
single-query baseline. Production lift numbers require a real local LLM and
are deliberately not claimed from a rigged fixture.

### Reproducing

```bash
node scripts/run-bench.mjs --rerank
node scripts/run-bench.mjs --rerank --rerank-model gte-reranker-modernbert
```

---

## 17. HNSW Graph ANN alongside IVF (Issue #201)

### Implementation

`src/hnsw.ts` — pure JS/TS HNSW (Malkov & Yashunin 2016) sharing the IVF
contract: build → serialize → `hnsw.json` → search as a candidate pre-filter.
Key properties:

- **No training phase.** The graph builds by incremental insertion
  (`insertHnsw`), which is also the watch-rebuild path: tombstoned deletes
  (`deleteHnsw`) keep removed chunks searchable-through-but-hidden, so a
  persisted graph can grow without a full rebuild.
- **Diversity heuristic pruning** (Algorithm 4). The first implementation used
  blind top-M pruning, which severed the just-added edge at overflowing
  neighbors — on the 5000-vector clustered corpus recall collapsed to 44.4%
  and did NOT respond to `ef` (stranded regions). The heuristic restores
  connectivity: 100% recall at every ef on both bench corpora.
- **Determinism**: level assignment is seeded per node (`seed + idx`), so
  full rebuilds from the same insertion order are identical.
- **Hardened `deserializeHnsw`** with the same discipline as
  `deserializeIVF` (format, header, per-level link caps, self/duplicate
  links, entry-point-on-top-layer, tombstone range, count-vs-chunks).

### Measured (bench/ann-recall.mjs, clustered corpus, dim 256)

| n | Engine | Build | Config | Recall@10 | p50 latency |
|---|---|---|---|---|---|
| 1000 | IVF | 85 ms | nprobe 4 | 100% | 0.098 ms |
| 1000 | HNSW | 2605 ms | ef 16 | 100% | 0.212 ms |
| 5000 | IVF | 1025 ms | nprobe 4 | 100% | 0.252 ms |
| 5000 | HNSW | 20027 ms | ef 16 | 100% | 0.215 ms |

**Query-side: HNSW ≥ IVF** — 100% recall at equal-or-lower p50 latency
(satisfying the acceptance criterion's first branch). **Build-side: IVF wins
~20×** (no training vs O(n log n) graph construction in JS), and the sidecar
is rebuilt by every full index run — so the automatic sidecar for large
corpora keeps **IVF as the default engine**; the criterion's second branch
(documented result, IVF remains default) covers the build-time trade-off.

### Decision

1. `--ann hnsw` opts into the graph engine end-to-end (indexer sidecar +
   search probe + `check --fix` corrupt-sidecar repair); corrupt `hnsw.json`
   degrades to brute force silently, like `ivf.json`.
2. Bare `--ann` and the automatic threshold path stay on IVF until either
   (a) the JS graph build gets an order of magnitude cheaper (worker
   parallelism, WASM SIMD — see §13), or (b) incremental watch rebuilds
   start reusing the persisted graph (the `insertHnsw`/`deleteHnsw` API is
   already in place for that).
3. `--ef <n>` tunes the HNSW search breadth (default 64; recall saturates
   at 100% already at ef 16 on the bench corpora — the default leaves
   headroom for noisier real-world distributions).

### Reproducing

```bash
node bench/ann-recall.mjs                 # IVF + HNSW curves side by side
mdss index --db ./notes --ann hnsw        # hnsw.json sidecar
mdss search --db ./notes --ann hnsw "query"
```

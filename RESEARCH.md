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
The E5 family is trained with instruction prefixes: documents must be embedded
as `passage: <text>` and queries as `query: <text>`. Omitting them measurably
degrades retrieval. The model registry encodes this per-model, because
**`bge-m3` is the opposite — it wants no prefix at all.** Getting this wrong is
a silent quality bug.

Qwen3-Embedding uses a third profile: documents remain unprefixed, queries use
the model's retrieval instruction, and token vectors are pooled from the last
token rather than averaged. The registry pins these semantics together with a
specific ONNX revision. A persisted adapter fingerprint covers formatting,
pooling, normalization, and dimension, so changing a profile cannot silently
reuse incompatible vectors or checkpoints; model-independent lexical records
remain reusable. `qwen3-embedding-0.6b` is opt-in (~613 MB q8, 1024 dimensions);
its published benchmark motivated support, but it has not yet been compared on
the bilingual project corpus used in Experiment B. This partial enablement does
not complete issue #50 until #55, #56, and #60 satisfy its provenance,
human-judged benchmark, and full adapter-contract gates.

### Chunk by heading, not by page
Embedding a whole multi-section page into one vector blurs distinct topics.
We split on Markdown headings (`#`..`######`); sections over ~1400 chars split
again on blank lines. Search then returns the relevant *section*, with its
heading, not just "the page where the word appears somewhere."

### Hybrid ranking via Reciprocal Rank Fusion
Pure vectors miss exact identifiers (`win32`, `TextIOWrapper`, error codes);
pure lexical search misses paraphrases. We compute two rankings — cosine and
BM25 over persisted postings — and fuse them with RRF
(`score = Σ 1/(k + rank)`, `k=60`). Schema-v0/v1/v2 compatibility retains the
original exact token-overlap ranking used for the measurements below. RRF
needs no score normalization or weight tuning, which is what makes it robust
across very different score scales. Equal scores share one rank contribution;
otherwise arbitrary corpus order can cancel a real win from the other lane.

Schema-v3 `bm25-v2` documents prepend the active Markdown heading context to
the chunk body, without repeating a title-derived first heading or the leaf
heading. This mirrors the context already used by embeddings: an exact parent
topic can distinguish two nested chunks whose bodies share the same terms.
Existing `bm25-v1` indexes remain searchable and rebuild only their lexical
records on the next indexing run; stored vectors are reused.

### Stop-words protect the lexical lane
Cross-lingual queries share function words ("при", "the", "для") with
irrelevant documents, letting lexical scoring promote noise. A small ru/en
stop-list is removed before lexical scoring so RRF fuses signal, not filler.
Engineering content words such as `код` / `кода` are intentionally retained.

### Incremental by content hash
Each file's md5 is stored. Re-indexing reuses embeddings for unchanged files
and only re-embeds what changed — a no-op re-index of 46 files is sub-second.
Changing the model invalidates all vectors and forces a clean rebuild
(dimensions and prefix semantics differ).

## 6. Experiment C — does cross-encoder re-ranking help?

The historical measurements in this experiment used cosine + exact token
overlap through RRF; schema-v3 BM25 was implemented later and has not been
measured on this table. Both first-pass algorithms score every chunk
*independently*. A cross-encoder reads the query and each candidate **together**, capturing
pairwise relevance — at the cost of one forward pass per candidate. We compared
top-1 with and without `--rerank` (`Xenova/bge-reranker-base`, single-class
XLMRoBERTa, raw logit = relevance score) on the real bilingual wiki:

| Query | Top-1 without rerank | Top-1 with rerank | Effect |
|-------|----------------------|-------------------|--------|
| как добавить новую страницу в базу знаний | AGENTS.md (cos 0.817) | **KB Update Rule** (rr −1.38) | rerank finds the procedural doc, not the generic rules page |
| семантический поиск по базе | AGENTS.md (cos 0.861) | **md-semantic-search overview** (rr +3.52) | rerank promotes the project page that *is* the answer |
| правила обновления базы знаний агентами | AGENTS.md (cos 0.858) | **KB Update Rule** (rr +2.33) | same pattern: targeted doc wins over the umbrella page |

**Findings:**

- **RRF scores barely separate** — every first-pass score sat in ~0.02–0.03, so
  a generic rules page (AGENTS.md) kept winning because its many overlapping
  chunks dominated RRF. The reranker's logits span a **~7-point range**
  (−3.8…+3.5), giving confident separation.
- **In all three queries the reranker fixed top-1**, promoting the document
  that actually answers the question (procedure/overview pages) over the
  umbrella rules page that merely *mentions* the words.
- **Cost:** a second ~280 MB model + one batched forward pass per candidate.
  The candidate pool is capped (default `max(20, k*3)`), and the reranker is
  lazy — nothing loads unless `--rerank` is requested. On a 856-chunk index
  the re-rank pass stays sub-second once the model is cached.

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

The `hard-negative` category (1.000 nDCG) confirms the hybrid lane separates
near-duplicate topics; `paraphrase`/`alias` (0.83–0.88) are the categories
where the embedding is doing real semantic work and where model changes will
show up first.

## 8. Reproducing

```bash
# Build with the default, then with the heavy model, and compare a known query:
mdss index  --db ./your-wiki
mdss search --db ./your-wiki --semantic "a paraphrase of something you know is in there"

mdss index  --db ./your-wiki --model bge-m3
mdss search --db ./your-wiki --semantic "the same paraphrase"

mdss index  --db ./your-wiki --model qwen3-embedding-0.6b
mdss search --db ./your-wiki --semantic "the same paraphrase"
```

Use `--semantic` to see the raw vector ranking (no lexical fusion) when
evaluating a model — that isolates embedding quality from the lexical lane.

## 9. Recommendations

| If you want… | Use |
|--------------|-----|
| Sensible default, fast, ~280 MB | `e5-base` (default) |
| Maximum cross-lingual quality, disk/time no object | `bge-m3` |
| Evaluate a newer 0.6B multilingual model locally | `qwen3-embedding-0.6b` (~613 MB q8) |
| Smallest footprint and your queries are same-language & literal | `e5-small` (with eyes open) |
| Best precision on exact identifiers | keep hybrid on (don't pass `--semantic`) |
| Sharpest top-k on a larger corpus | add `--rerank` (cross-encoder, +280 MB) |

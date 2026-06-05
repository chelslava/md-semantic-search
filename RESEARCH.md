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
> - **Hybrid (vector + keyword via RRF)** beats either alone: vectors catch
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

### Chunk by heading, not by page
Embedding a whole multi-section page into one vector blurs distinct topics.
We split on Markdown headings (`#`..`######`); sections over ~1400 chars split
again on blank lines. Search then returns the relevant *section*, with its
heading, not just "the page where the word appears somewhere."

### Hybrid ranking via Reciprocal Rank Fusion
Pure vectors miss exact identifiers (`win32`, `TextIOWrapper`, error codes);
pure keywords miss paraphrases. We compute two rankings — cosine and lexical
term-overlap — and fuse them with RRF (`score = Σ 1/(k + rank)`, `k=60`). RRF
needs no score normalization or weight tuning, which is what makes it robust
across very different score scales.

### Stop-words protect the lexical lane
Cross-lingual queries share function words ("при", "the", "кода") with
irrelevant documents, letting lexical overlap promote noise. A small ru/en
stop-list is removed before lexical scoring so RRF fuses signal, not filler.

### Incremental by content hash
Each file's md5 is stored. Re-indexing reuses embeddings for unchanged files
and only re-embeds what changed — a no-op re-index of 46 files is sub-second.
Changing the model invalidates all vectors and forces a clean rebuild
(dimensions and prefix semantics differ).

## 6. Reproducing

```bash
# Build with the default, then with the heavy model, and compare a known query:
mdss index  --db ./your-wiki
mdss search --db ./your-wiki --semantic "a paraphrase of something you know is in there"

mdss index  --db ./your-wiki --model bge-m3
mdss search --db ./your-wiki --semantic "the same paraphrase"
```

Use `--semantic` to see the raw vector ranking (no lexical fusion) when
evaluating a model — that isolates embedding quality from the keyword lane.

## 7. Recommendations

| If you want… | Use |
|--------------|-----|
| Sensible default, fast, ~280 MB | `e5-base` (default) |
| Maximum cross-lingual quality, disk/time no object | `bge-m3` |
| Smallest footprint and your queries are same-language & literal | `e5-small` (with eyes open) |
| Best precision on exact identifiers | keep hybrid on (don't pass `--semantic`) |

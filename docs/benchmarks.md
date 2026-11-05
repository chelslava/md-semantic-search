# MDSS Benchmark & Comparison Suite

Official latency, memory footprint, and scale benchmarks for **md-semantic-search** (MDSS) v1.0.0 LTS.

---

## 1. Large-Scale Corpus Performance (100,000 to 1,000,000 Chunks)

Evaluated on standard 384-dimensional vector embeddings (e.g. `e5-base`, `bge-small`) on consumer hardware (Apple M-series / AMD Ryzen 9 / Intel i7):

| Corpus Size | Storage Format | RAM Footprint | Search Latency (P50) | Search Latency (P95) | Search Latency (P99) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **10,000 chunks** | `vectors.bin` (FP32) | 15 MB | **0.8 ms** | **1.2 ms** | 1.9 ms |
| **100,000 chunks** | `vectors.bin` (FP32) | 146 MB | **7.4 ms** | **9.1 ms** | 12.0 ms |
| **100,000 chunks** | `vectors.bin` (INT8) | **36 MB** | **3.8 ms** | **5.2 ms** | 7.1 ms |
| **1,000,000 chunks** | `vectors.bin` (INT8) + IVF | **366 MB** | **14.2 ms** | **18.6 ms** | 24.5 ms |

---

## 2. Competitive Architectural Comparison

| Dimension | **md-semantic-search** (MDSS) | **Qdrant** | **ChromaDB** | **ripgrep** (`rg`) |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Paradigm** | Hybrid Semantic + BM25 + Graph | Standalone Vector DB | Embedded Vector DB | Lexical Regex |
| **Infrastructure Overhead** | **Zero** (Single CLI / library) | Docker daemon / Rust service | Python / SQLite runtime | Zero (CLI) |
| **Cold Start Startup** | **< 15 ms** (Zero-copy binary) | 2-5 sec (daemon boot) | 1-3 sec | < 5 ms |
| **Markdown Awareness** | **Native** (Wikilinks, Headings, YAML) | Generic text payload | Generic text payload | Line-by-line regex |
| **Cross-Lingual Retrieval**| **Full** (Multilingual Transformers) | Requires external embedder | Requires external embedder | None (literal only) |
| **Privacy & Offline** | **100% Local, Zero Cloud** | Local or Cloud | Local or Cloud | 100% Local |

---

## 3. How to Run the Benchmark
Execute the standalone scale test directly from the repository:
```bash
node bench/benchmark-1m.mjs 100000
```

## 4. RAG Answer Faithfulness (issue #229)

`bench/rag-faithfulness.mjs` measures the quality of the synthesis loop behind
`mdss ask` / `mdss chat` against the frozen golden corpus: 30 answerable
queries (reference docs come from the golden set qrels) and 8 unanswerable
queries (no relevant doc exists). Metrics are deterministic — no LLM judge:

| Metric | Definition |
|---|---|
| citation precision | share of used citations pointing at a golden doc |
| citation recall   | share of golden docs cited by the answer |
| support rate      | share of answer sentences containing a golden-doc content term (groundedness proxy) |
| spurious rate     | unanswerable queries where the answer cites any corpus doc (fabricated grounding) |

The extractive profile (offline, deterministic) has a committed baseline with
a ±5pp drift gate; the LLM profile runs report-only against
`MDSS_SMOKE_ENDPOINT`:

```bash
node bench/rag-faithfulness.mjs                                  # extractive + fake embedder, gate vs baseline
node bench/rag-faithfulness.mjs --model granite-multilingual-311m  # real embedder, report-only
node bench/rag-faithfulness.mjs --endpoint http://127.0.0.1:8080/v1  # adds the LLM profile
```

First measured slice (extractive, fake embedder, k=6): citation precision
70.0% · recall 83.3% · support 67.6%; extractive synthesis never refuses —
spurious-citation rate 100% on unanswerable queries, which is the documented
trade-off of the zero-dependency fallback and the number an LLM profile
should improve on.


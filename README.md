# md-semantic-search

[![npm version](https://img.shields.io/npm/v/md-semantic-search.svg)](https://www.npmjs.com/package/md-semantic-search)
[![npm downloads](https://img.shields.io/npm/dm/md-semantic-search.svg)](https://www.npmjs.com/package/md-semantic-search)
[![publish](https://github.com/chelslava/md-semantic-search/actions/workflows/publish.yml/badge.svg)](https://github.com/chelslava/md-semantic-search/actions/workflows/publish.yml)
[![node](https://img.shields.io/node/v/md-semantic-search.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/md-semantic-search.svg)](./LICENSE)

**Local, private semantic (vector) search over any folder of Markdown files.**

Find passages by *meaning*, not just keywords — and across languages (ask in
one language, match documents written in another). Runs fully on your machine
via [transformers.js](https://github.com/xenova/transformers.js): no API keys,
no cloud calls, no vector database. Your notes never leave the disk.

```bash
npx md-semantic-search index  --db ./docs
npx md-semantic-search search --db ./docs "how do I rotate the API token"
```

---

## Why

Keyword search misses paraphrases. A query like *"как починить зависший ввод на
windows"* will never match a page titled *"win32 stdin re-wrap closes buffer"* —
zero shared words, different language. Semantic search embeds both into the same
vector space and matches on meaning. This tool was extracted from a real wiki
where exactly that gap kept biting; see **[RESEARCH.md](./RESEARCH.md)** for the
measurements that shaped its defaults.

## Features

- 🔌 **Any folder, anywhere.** Point `--db` at any directory of `.md`/`.markdown`
  files. It does **not** have to live inside this project. Recursive by default.
- 🌍 **Cross-lingual.** Multilingual embeddings (default `granite-multilingual-311m`, Apache-2.0).
- 🧭 **Markdown-aware context.** Each embedding includes the full active heading
  path (`title > h1 > h2 > ...`), so a deeply nested passage remains searchable
  by its parent topics without an LLM-generated context step.
- 🧠 **Hybrid ranking.** Reciprocal Rank Fusion of vector similarity (meaning)
  and persisted BM25 postings (exact names like `win32`, `TextIOWrapper`).
- ⚡ **Two-level incremental.** Per-file md5 (unchanged files skip work) **plus**
  per-chunk hash — inside a *changed* file, sections whose text is unchanged
  reuse their stored vector. Editing one place in a long file re-embeds only the
  affected section, not the whole file.
- 🔒 **Private & offline.** Model downloads once, then no network. Nothing is
  uploaded anywhere.
- 📦 **Zero infra.** One JSON index, brute-force cosine in memory. No Pinecone,
  no Qdrant, no pgvector. Scales fine to thousands of chunks.
- 🗜️ **Compact index.** Vectors are stored as base64 `Float32Array` blobs
  instead of decimal JSON — ~3.2× smaller index files and ~12× faster loads
  on a real corpus. Old decimal indexes are read transparently and migrated
  on the next `index` run.
- 🖥️ **Daemon mode.** `mdss serve` keeps the parsed index AND the embedding
  model warm in memory across queries (no ~280 MB reload per search), with an
  optional `--watch` flag that re-indexes incrementally when your notes change.
- 🔏 **Crash-safe concurrent writes.** Every index build takes a
  `<index>/.mdss.lock` (self-healing by pid-liveness), so `mdss index` in one
  terminal plus `mdss serve --watch` never interleave into a torn index. Long
  builds also checkpoint embedding progress and resume after interruption.

---

## Architecture & Retrieval Pipeline

`md-semantic-search` implements a fully local, deterministic Markdown-native retrieval pipeline designed for small-to-medium RU/EN engineering knowledge bases.

```
┌────────────────┐     ┌───────────────────────┐     ┌──────────────────────┐
│ Markdown Notes │ ──> │ Structural AST Chunker│ ──> │ Typed Frontmatter &  │
│  (.md files)   │     │ (src/markdown-parser) │     │ Canonical Identity   │
└────────────────┘     └───────────────────────┘     └──────────────────────┘
                                                                │
     ┌──────────────────────────────────────────────────────────┘
     ▼
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ Contextual Embeddings│     │ Field BM25F Postings │     │ Bounded Wikilink /   │
│   (src/core.mjs)     │     │  (src/lexical.mjs)   │     │ Backlink Graph       │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
            │                            │                            │
            └────────────────────┬───────┴────────────────────────────┘
                                 ▼
                     ┌──────────────────────┐
                     │ Reciprocal Rank (RRF)│
                     │  + Result Collapse   │
                     │  (src/search.mjs)    │
                     └──────────────────────┘
```

1. **Structural AST Parsing** ([`src/markdown-parser.mjs`](./src/markdown-parser.mjs)): Markdown is parsed into structural blocks (headings, fenced code blocks, tables, blockquotes, lists). Block boundaries are preserved atomically.
2. **Typed Frontmatter & Canonical Identity** ([`src/frontmatter.mjs`](./src/frontmatter.mjs)): YAML frontmatter is parsed into typed metadata (`title`, `aliases`, `tags`, `project`, `type`, `status`, `canonical`, `canonicalRef`).
3. **Contextual Embeddings** ([`src/core.mjs`](./src/core.mjs)): Passages combine title, full heading hierarchy (`Title > H1 > H2`), and body text, following Anthropic's Contextual Retrieval design to eliminate lost context without an LLM expansion step.
4. **Field-Aware BM25F & Fuzzy Lookup** ([`src/lexical.mjs`](./src/lexical.mjs)): Inverted lexical postings score `title`, `aliases`, `headingPath`, and `body` with dedicated field weights, complemented by bounded Damerau-Levenshtein fuzzy title matching.
5. **Relationship Graph** ([`src/wikilinks.mjs`](./src/wikilinks.mjs)): Wikilinks (`[[note]]`) and relative Markdown links resolve to canonical target notes to compute outgoing links and backlinks.
6. **Reciprocal Rank Fusion & Collapse** ([`src/search.mjs`](./src/search.mjs), [`src/collapse.mjs`](./src/collapse.mjs)): Fuses dense cosine similarity, BM25F lexical scoring, and fuzzy candidates with RRF, followed by optional document collapse (`--max-per-file`) and cross-encoder reranking ([`src/rerank.mjs`](./src/rerank.mjs)).

---

## Comparison with Alternatives

| Approach | Stronger than mdss at | mdss advantage for its target segment |
|---|---|---|
| **QMD** | Query expansion, HyDE, LLM reranking, MCP/SDK ecosystem | Smaller default footprint, Node 20.9+, zero native C++ runtime (pure ONNX.js), fast incremental chunk reuse |
| **Obsidian Hybrid Search** | Obsidian GUI integration, Obsidian vault plugins | Standalone CLI & HTTP API, not tied to Obsidian, crash-safe atomic indexing, robust incremental re-index |
| **Vector Databases (Qdrant/Pinecone)** | Multi-million chunk scale, distributed vector index, cloud replication | Zero infra, single JSON index, no server/daemon required, fast in-memory sweep for 10k–50k chunks |
| **Grep / Fzf** | Zero model load time, instant literal string matching | Cross-lingual matching (RU/EN), paraphrase retrieval, semantic understanding while retaining exact BM25 lexical precision |

---

## Install

Requires **Node.js ≥ 20.9**. Supported runtimes:

| Runtime | Status | Support |
|---|---|---|
| **Node 22, 24** | Maintained LTS lines | Tested in CI |
| **Node 20.9–20.x** | EOL since 2026-04-30 | Runs, prints a deprecation warning on stderr; dropped in **v3.0.0** |

Native dependencies ship as prebuilt binaries — no compiler toolchain needed
on any platform.

Run on demand with `npx` (no install):

```bash
npx md-semantic-search --help
```

Or install globally for the short `mdss` alias:

```bash
npm install -g md-semantic-search
mdss --help
```

Or from source:

```bash
git clone https://github.com/chelslava/md-semantic-search
cd md-semantic-search
npm install
node bin/cli.mjs --help
```

For headless server deployments there is a Docker path — see
[docs/deploy.md](./docs/deploy.md).

---

## Library usage

The package exports a stable programmatic API (no CLI required) — for scripts,
agents, and editors that want to run many queries in one process.

```js
import { buildIndex, search, loadIndex, searchIndex, resolveModel, MODELS } from 'md-semantic-search';

// 1. Build (or refresh) an index — same as `mdss index --db ./docs`.
await buildIndex({ db: './docs', indexDir: './.mdss', cacheDir: '~/.cache/mdss' });

// 2a. One-shot search — parses the index on every call (same as `mdss search`).
const hits = await search({
  indexDir: './.mdss', cacheDir: '~/.cache/mdss',
  query: 'how do I rotate the API token', k: 6,
});
for (const h of hits) console.log(h.file, h.heading, h.cosine);

// 2b. Repeated queries in one process — parse the index ONCE and reuse it.
//     The embedding model is cached in-process too (issue #2).
const idx = loadIndex('./.mdss');                          // parse once
const r1 = await searchIndex({ loaded: idx, cacheDir: '~/.cache/mdss', query: 'failover runbook' });
const r2 = await searchIndex({ loaded: idx, cacheDir: '~/.cache/mdss', query: 'backup schedule' });
//                                                          ^^ reuses parsed chunks + warm model
```

The extractor pipeline is cached per model id (see `getExtractor`), so the
second and later queries skip both the file read and the model load.

Also exported: `resolveModel`, `MODELS`, `DEFAULT_MODEL`, `chunkHash`,
`tokenize`, `keywordScores`, `rrf`, `cosine`, `encodeVec`/`decodeVec`,
`walkMarkdown`/`parseFile`/`chunkMarkdown`, `splitFrontmatter`, `extractTitle`,
`globToRegExp`. Types come from JSDoc (`// @ts-check` + `checkJs`).
`keywordScores` remains the legacy exact-overlap helper for schema-v0/v1/v2
indexes and existing library consumers; schema-v3 search uses persisted BM25.

## Usage

### 1. Build the index

```bash
mdss index --db /path/to/your/markdown
```

First run downloads the model (~280 MB) — and the download itself is
**visible**: an aggregated bar on stderr shows percent across every file of the
model directory, live MB/s and ETA (the same bar reappears when `--rerank`
first pulls the cross-encoder). Under `--json` the bar is replaced by throttled
`{"type":"download-progress", …}` / `{"type":"download-complete", …}` events
**on stderr**, so stdout stays machine-readable. A warm cache produces no
download output at all, and `--offline` behaves exactly as before. The index
is written to `<db>/.mdss/`
by default (override with `--index-dir`). Re-run after editing your notes — it's
incremental at two levels: unchanged files are skipped via their md5, and inside
a changed file only the sections whose text actually changed are re-embedded
(chunks carry a `chunkHash` in `vectors.json`; an append to a long log re-embeds
just the new entry). The index output reports the split, e.g.:

```
Indexed 64 file(s) → 725 chunks (725 reused [5 chunk-level, 720 file-level], 0 embedded), ... 0.6s
```

Schema-v3 indexes persist each chunk's full Markdown heading path plus a compact
BM25 inverted index inside `vectors.json`. Search tokenizes only the query;
unchanged files and a model-independent hash of the exact lexical document
(`title + ancestor headings + leaf heading + text`) reuse lexical analysis
independently of vector reuse. Parent heading changes reanalyze only the affected
lexical subtree, while model-only changes reuse unchanged lexical records.
New indexes write `bm25-v2`; existing `bm25-v1` indexes remain searchable and
upgrade on the next index build. Schema-v0/v1/v2 remain searchable through the
legacy exact-token overlap lane. A v2 rebuild reuses its contextual vectors
while adding BM25; v0/v1 still re-embed once because they lack contextual
passages.

During long builds, mdss atomically checkpoints progress every eight embedding
batches (about 256 chunks) to `<index>/.checkpoint.json`. The canonical
`vectors.json` and `.hashes.json` remain the last complete searchable generation;
after an interruption, the next build resumes from the compatible checkpoint.
The sidecar is removed after the completed generation is published. This is
automatic and does not change the CLI or canonical index format.

For scripts/CI, `mdss index --json` emits the build result as JSON (the exact
`buildIndex` return value: `files`, `chunks`, `reused`, `embedded`, `dim`,
`model`, `vectorsPath`) instead of the prose — e.g. to assert "0 embedded"
(fully incremental re-index) in a cron job.

### Inspect the index (`mdss stats`)

`mdss stats` prints index statistics by parsing only `vectors.json` +
`.hashes.json` — **no model load, no network**, so it's a cheap sanity check
after a re-index or for staleness detection in scripts:

```bash
mdss stats --db /path/to/your/markdown
# Index at /path/to/your/markdown/.mdss
#   format: binary-v1 · model: e5-base (dim 768)
#   schema: v3 · lexical: bm25-v2
#   chunks: 725 · files: 64
#   size: 42.1 KiB (vectors.json)
#   built: 2026-08-08T09:42:58.331Z (2m 12s ago)
#   db: /path/to/your/markdown
```

`mdss stats --json` prints machine-readable JSON: `indexDir`, `schemaVersion`,
`format` (`binary-v1` vs legacy `decimal`), `lexicalFormat`, `lexicalStatus`,
`model` (id@revision) / `modelAlias`, `dim`, `chunks`, `files`, `indexBytes`,
`built`, `ageSeconds`, `db`. Stats validates the same schema-v3 envelope and
stored vectors as the loader; malformed current metadata, unknown formats, and
corrupt vector storage exit with an actionable error instead of reporting a
healthy index.

Indexes also carry an explicit `schemaVersion` (issue #39): reading or
re-indexing over an index written by a **newer** mdss fails with a clear
"upgrade md-semantic-search" error instead of silently misparsing, and corrupt
root/schema/chunk shapes, unknown current formats, malformed v3 lexical data,
and corrupt vectors (non-canonical/truncated base64, NaN/Infinity, wrong or
model-inconsistent dimensions) are
rejected at load with an actionable rebuild/upgrade hint.

Index writes are **serialized across processes** with a lockfile
(`<index>/.mdss.lock`, issue #37): `mdss serve --watch` re-indexes on a timer
while a manual `mdss index` (or a second terminal) may run — without a lock two
builds interleave and can leave `vectors.json`/`.hashes.json` from different
runs. `buildIndex` acquires the lock for the whole build and releases it in a
`finally`; a second process gets a clear `index is being written by pid NNN`
error, and `serve --watch` politely defers its cycle until the other writer
finishes. A crashed writer can't wedge the index — the lock self-heals by
pid-liveness + staleness (a dead-pid or abandoned lock is reclaimed).

### Export the index (`mdss export`)

Export chunks and decoded embedding vectors to JSONL, CSV, or Parquet for downstream pipelines (LangChain, LlamaIndex, Qdrant, Pandas):

```bash
# Export all chunks with decoded float vectors as JSONL:
mdss export --db ./notes --format jsonl > chunks.jsonl

# Export metadata only without vectors (fast & compact):
mdss export --db ./notes --format jsonl --no-vectors > chunks_meta.jsonl

# Export as CSV (metadata only):
mdss export --db ./notes --format csv > chunks.csv

# Export directly to file:
mdss export --db ./notes --format jsonl --output ./data/corpus.jsonl
```

#### JSONL output schema:
```json
{
  "file": "runbooks/failover.md",
  "title": "Database Failover",
  "heading": "Step 2: Promote Replica",
  "headingPath": ["Database Failover", "Step 2: Promote Replica"],
  "text": "Run the promote script...",
  "vec": [0.012, -0.045, 0.089],
  "chunkHash": "a1b2c3...",
  "startLine": 14,
  "endLine": 28
}
```

#### Downstream integration example (Python / LangChain / LlamaIndex):
```python
import json

# Load into custom vector store / pipeline
with open("chunks.jsonl") as f:
    for line in f:
        chunk = json.loads(line)
        text = chunk["text"]
        vector = chunk["vec"]
        meta = {"file": chunk["file"], "heading": chunk["heading"]}
```

### Diagnose problems (`mdss check` / `mdss doctor`)

`mdss check` (alias: `mdss doctor`) is an **offline, read-only** diagnostic for
the index/db/model-cache trio — like `mdss stats`, it never loads the embedding
model and never touches the network, but its job is answering *"why is search
broken?"* rather than *"what's in the index?"*:

```bash
mdss check --db /path/to/your/markdown
# check: /path/to/your/markdown/.mdss
#   ok    vectors.json: parses (schema v3, binary-v1)
#   ok    .hashes.json: parses (64 file(s))
#   ok    chunks: 725/725 vectors valid (dim from index)
#   ok    db /path/to/your/markdown: fresh
#   ok    model cache: e5-base present at ~/.cache/mdss/Xenova/multilingual-e5-base
# check: healthy (exit 0)
```

It validates, in order: `vectors.json` exists / parses; root, `schemaVersion`,
schema-v3 BM25 data, required current chunk metadata, model dimension, and
`format` are recognized;
`.hashes.json` parses; **every chunk's decoded vector**
with the same validator the loader uses (dim mismatch, NaN/Infinity, truncated
base64, vec-less legacy chunks — the first five offenders are named); db
staleness (newest file mtime vs `built`, same 5s grace as the stale warning);
and the Transformers.js FileCache layout (`<cache-dir>/<model-id>` for `main`,
with a further `<revision>` directory for pinned revisions). A missing model
cache is a *warning* by default
(the first online run downloads it) and a *failure* under `--offline`.

Exit code is `0` when healthy and `1` with a problem summary otherwise;
`--json` prints the full structured report (`healthy`, `index`, `hashes`,
`chunks`, `db`, `model`) for scripting and CI gates.

### 2. Search

```bash
mdss search --db /path/to/your/markdown "your question in plain language"
```

Example output:

```
Top 3 for: "how do I add a new translation language"

1. [cos 0.833] i18n Application Analysis
   i18n-analysis.md › Language status
   | Language | File | Status | ... English | en/shared.json | complete | ...

2. ...
```

### Reranking (optional, sharper results)

The default ranking scores each chunk *independently* (vector cosine + BM25
fused with RRF; legacy indexes use exact overlap). A **cross-encoder** reads the query and the
passage **together**, capturing pairwise relevance that independent scores can
miss — at the cost of one forward pass per candidate.

```bash
mdss search --db /path/to/your/markdown "how do I rotate the api token" --rerank
```

- The first pass pulls a wider candidate pool (default `max(20, k*3)` chunks),
  the cross-encoder (`gte-reranker-modernbert`, ~144 MB, downloaded on first
  use) re-scores them as query↔passage pairs, and the best `k` survive.
- Results from a re-ranked search carry a `rerankScore` field in `--json` mode.
- Programmatic use: `rerank: true` in `search()`/`searchIndex()`, `rerankPool`
  to size the pool, or `rerankFn` to swap in your own scorer. The API server
  accepts `"rerank": true` in the `/search` body.
- The reranker is lazy: nothing loads unless `--rerank` is actually requested,
  so searches without it pay zero extra cost.
- **Reranker registry** (issue #203): `--rerank-model <alias>` picks the model —
  `gte-reranker-modernbert` (Alibaba gte-reranker-modernbert-base, ~144 MB,
  ModernBERT 8k context, Apache-2.0; **default since the #203 measurement** —
  nDCG@10 0.9318 vs 0.8839) or the pre-#203 incumbent `bge-reranker-base`
  (~278 MB, kept for reproducibility); raw `id@revision` also accepted.
  Programmatic: `rerankModel: 'bge-reranker-base'`.
- **Multi-query expansion** (issue #203): `--multi-query <n>` embeds N query
  variants (the original + N-1 LLM paraphrases from `--llm-endpoint`, one extra
  embedding each) and fuses the dense rankings with union-RRF — a recall lift
  on heavy paraphrases, at the cost of N−1 extra embeddings and one LLM call.
  Without an endpoint (or on any LLM failure) it silently degrades to the
  single-query baseline. Programmatic: `multiQuery: 3` (+ `llmEndpoint`).

### 3. Ask & Interactive Multi-turn Chat (`mdss ask`, `mdss chat`)

`md-semantic-search` includes a grounded RAG QA engine that operates fully offline by default with zero external dependencies, or connects optionally to local/remote LLMs (Ollama, OpenAI-compatible APIs).

> ⚠️ **Data egress**: a non-loopback `--llm-endpoint` (or `--embedder openai`) sends **note content** to that external service. The CLI prints a one-time warning before the first send; see [SECURITY.md → Data egress](./SECURITY.md#data-egress-issue-183). Loopback endpoints (local Ollama/llama.cpp) and the default extractive/local-embedder paths keep everything on your machine.

```bash
# One-shot grounded QA with citations:
mdss ask --db ./notes "What is the token expiration policy?"

# Multi-turn persistent chat session:
mdss chat --db ./notes

# Resume the most recent session or a specific session:
mdss chat --db ./notes --resume
mdss chat --db ./notes --session my-session-id

# One-shot query into a persistent session:
mdss chat --db ./notes --session my-session-id "What about database failover?"
```

- **Offline Extractive Synthesis**: Zero-dependency default extracts salient factual sentences with strict `[file › heading]` source provenance.
- **Abstention instead of fabrication** (issue #238): when no retrieved passage carries real query support, the extractive path **refuses** — "No answer found in the notes" with the closest passages as explicitly non-answer context and **zero citations** — instead of citing excerpts it cannot ground (RESEARCH §18a: the unanswerable spurious-citation rate drops 100% → 0%). Tune with `--min-answer-confidence <n>` (default 0.13; `0` restores the never-abstain behavior; env `MDSS_MIN_ANSWER_CONFIDENCE`). LLM synthesis is untouched by the gate.
- **OpenAI-compatible chat with SSE streaming** (issue #199): with `--llm-endpoint`, synthesis speaks the `/chat/completions` lingua franca — llama.cpp, LM Studio, vLLM, and Ollama (`.../v1`) all work **without code** — and answers **stream token-by-token** into `mdss ask`, `mdss chat`, the TUI RAG panel (`mdss search -i --rag`), and the web UI (`mdss serve` → ✦ Ask): the first token renders in milliseconds instead of after the whole generation.
  ```bash
  # llama.cpp / LM Studio / vLLM (OpenAI-compatible):
  mdss ask --db ./notes "What is the token expiration policy?" \
    --llm-endpoint http://127.0.0.1:8080/v1 --llm-model qwen2.5
  # Ollama's OpenAI-compatible surface:
  mdss chat --db ./notes --llm-endpoint http://127.0.0.1:11434/v1 --resume
  # Ollama's native API (pre-#199 wire format, also streamed):
  mdss ask --db ./notes "..." --llm-endpoint http://127.0.0.1:11434 --llm-provider ollama
  ```
  An endpoint that does not answer `/chat/completions` (404/405) is retried once on the Ollama-native `/api/generate`, so existing Ollama-root setups keep working with default flags; `--llm-provider` pins the wire format explicitly. A hung endpoint fails on the **idle timeout** (`MDSS_FETCH_TIMEOUT_MS` — armed on connect, reset on every token, issue #184), so a long generation is never killed mid-answer, and any failure degrades to the extractive synthesis.
- **Persistent Sessions**: Multi-turn sessions are stored in `<indexDir>/sessions/<id>.json` preserving full conversation turns, retrieved chunk provenance manifests (file, heading, exact line numbers, chunk hashes), and model metadata.
- **Context Carry-Over**: Follow-up turns re-rank and expand query tokens using prior conversational context.
- **Interactive REPL Commands**: `/session` (info), `/sources` (manifest of last turn), `/help`, `/exit`.

### 4. Serve (daemon, warm index + model)

```bash
mdss serve --db /path/to/your/markdown [--port 8747] [--host 127.0.0.1] [--watch]
```

`serve` is the long-running mode for editors, scripts, or anything that asks
many questions in a row: the index is parsed **once** and the embedding model
stays loaded in memory, so every request skips the ~280 MB model load and the
full `vectors.json` parse. `--watch` polls the base every **3 s** (configurable
via `--watch-interval`, no extra dependencies) and runs the incremental
re-index automatically. Detection is **content-confirmed**, not mtime-based
(issue #42): each candidate file's md5 is compared against the authoritative
per-file hashes the indexer wrote to `.hashes.json`, so a no-op write (touch,
chmod, an editor rewriting identical bytes) never triggers a re-index, and a
real edit caught inside a coarse mtime window (FAT, older SMB) is still picked
up. A **1 s settle debounce** (`--watch-delay`) collapses a burst of successive
saves (editor save → linter → save) into ONE re-index instead of a back-to-back
burst. New, changed, and removed files are all handled without restarting.

```bash
# query it with curl…
curl -X POST localhost:8747/search \
  -H 'content-type: application/json' \
  -d '{"query":"rotate api token","k":5}'
curl localhost:8747/health          # → {ok, chunks, model, dim, built, watching}
```

`POST /search` accepts `{"query": string, "k"?: number, "semanticOnly"?: bool,
"rerank"?: bool}` and replies `{"results": [{file, title, heading, cosine,
score, matches, snippet, rerankScore?}]}`. The CLI's `search --json` prints
the same hit shape.

**Federated multi-vault over HTTP** (issue #243): start the daemon with
`mdss serve --db ./primary --vault ./vault-b --vault ./vault-c` (each vault
carries its own `<vault>/.mdss` index) and `/search`/`/ask` accept
`"vaults": "all" | ["vault-b", …]` — configured vault **names** (or the exact
configured paths) only, never arbitrary client paths; the trust domain is
pinned to the configured roots (the #179 rule). Hits carry `vault`
attribution, per-vault failures surface as `vaultErrors` instead of fake
"no results" (#189), and `/health` lists the configured vaults with their
index state. The web UI gains a vault chip row (All vaults + one per vault)
and a vault badge on every result card. Chat sessions stay per-index:
`vaults` + `sessionId`/`chat` on `/ask` is a `400`.

**`POST /ask` — streamed grounded QA over SSE** (issue #199): start the daemon
with `--llm-endpoint` (chat backend — llama.cpp, LM Studio, vLLM, Ollama `.../v1`)
and `{"query": string, "k"?: number}` answers as `text/event-stream` frames:
`sources` (citations from retrieval) → `delta` (`{"text": "…"}` per token) →
`done` (`{answer, mode, citations, citationsUsed}`; `mode` is `endpoint` for the
LLM answer or `extractive` when it degraded, `citationsUsed` lists the citations
the answer text actually cites). **Multi-turn chat**: pass `"chat": true` to
start a persistent session or `"sessionId": "…"` to continue one — the same
`<indexDir>/sessions/` store `mdss chat` uses; a `session` frame opens the
stream and the `done` frame returns `sessionId`/`turnsCount`. The built-in web
UI has a **chat** toggle with history and a "new chat" reset. The same fairness gates as `/search` apply —
rate limit `429`, concurrency `503` — and an LLM call holds one concurrency
slot for its whole generation. Without `--llm-endpoint` the route answers
`400` instead of silently degrading. The built-in web UI ships an
**✦ Ask the notes** button that consumes this stream.

Or from a script / editor extension:

```js
const r = await fetch('http://localhost:8747/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'failover runbook', k: 3 }),
});
const { results } = await r.json();
```

The API is unauthenticated by default (or secured via `--api-key`) — by default it binds to **loopback only**
(`127.0.0.1`), so other machines on your LAN cannot reach it. Passing `--host 0.0.0.0` (or `MDSS_HOST`)
without authentication **refuses to start** — set an API key, or opt in explicitly with `--allow-unsecured`
(see [Securing remote deployments](#securing-remote-deployments)). Request bodies are capped at 64 KB
(oversized → `413`), malformed JSON gets a clear `400`, per-client request rate is capped at 60/min with a
burst of 10 (`429 + Retry-After` above that; tune via `--rate-limit`), and at most `CPU count` searches run
concurrently with a bounded wait queue (`503` when saturated; tune via `--max-concurrency`). Every response
carries `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`; the `Host` header is validated
against a loopback allowlist (`403` otherwise) so DNS-rebinding pages cannot read your notes cross-origin,
and CORS stays fully off unless you pass `--cors-origin`. `/health` exposes the live counters
(`in_flight`, `queued`, `rejected_total`).

### Web UI (built-in; disable with `--no-ui`)

By default `mdss serve` also serves a **zero-dependency web UI at `/`** — a keyboard-first search page
with live debounced results, term highlighting, score bars, tag/type/status filters, dark/light theme
(follows the system until you toggle it) and an API-key prompt when Bearer auth is enabled (the key is kept
in `sessionStorage`, same-origin only). It ships as plain HTML/CSS/JS split into three assets so a strict
CSP applies (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
frame-ancestors 'none'`) — no inline code, no external calls. Use `--no-ui` to restore pure JSON at `/`;
the JSON contract (`/search`, `/health`, `/help`) never changes. A Playwright smoke test runs weekly via
the opt-in `ui-smoke` workflow.

### Securing remote deployments

`mdss serve` is designed to be private-first: loopback bind by default, refuse-to-start for unauthenticated
network binds, DNS-rebinding protection, and rate limiting built in. To serve a team over the network safely:

1. **Keep TLS + auth at a reverse proxy** — mdss speaks plain HTTP on loopback; nginx/caddy terminate TLS.

   ```nginx
   # /etc/nginx/sites-available/mdss — TLS termination + Bearer-auth passthrough
   server {
     listen 443 ssl;
     server_name search.example.com;
     ssl_certificate     /etc/letsencrypt/live/search.example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/search.example.com/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:8747;
       proxy_set_header Host $host;            # must match --allowed-host if not loopback-named
       proxy_set_header X-Forwarded-For $remote_addr;
     }
   }
   ```

   ```caddyfile
   # Caddyfile — automatic HTTPS
   search.example.com {
     reverse_proxy 127.0.0.1:8747
   }
   ```

2. **Set an API key without leaking it into shell history or CI logs:**

   ```bash
   echo "$RANDOM_KEY" > /etc/mdss/api-key && chmod 600 /etc/mdss/api-key
   mdss serve --db /srv/wiki --host 127.0.0.1 --api-key-file /etc/mdss/api-key
   # or MDSS_API_KEY_FILE=/etc/mdss/api-key
   ```

3. **Behind nginx/caddy, split the rate-limit buckets per real client** — otherwise the whole team shares one 60/min budget:

   ```bash
   mdss serve --db /srv/wiki --host 127.0.0.1 --trust-proxy 127.0.0.1
   # nginx on the same box is now trusted; each X-Forwarded-For client gets its own bucket
   ```

4. **If you must expose mdss directly** (no proxy), require the key *and* keep the firewall tight:

   ```bash
   MDSS_API_KEY=$(openssl rand -hex 32) mdss serve --db /srv/wiki --host 0.0.0.0
   ```

   The startup banner warns loudly whenever an unsecured non-loopback bind was explicitly allowed.

5. **Browser clients on another origin?** Opt into CORS explicitly, exact origins only:
   `--cors-origin https://intranet.example.com`.

### 4. MCP Server (Claude Desktop, Cursor, Copilot, Antigravity)

`md-semantic-search` provides a zero-dependency **Model Context Protocol (MCP)** server over standard I/O (JSON-RPC 2.0). This allows AI agents and IDEs to query your local notes privately by meaning without uploading text to external clouds.

```bash
mdss mcp --db /path/to/your/markdown
```

**Streamable HTTP transport (issue #123):** a long-running daemon can expose
the same tools over HTTP — `mdss serve --db ./notes --mcp` mounts `/mcp`
(POST JSON-RPC, SSE channel on GET, `Mcp-Session-Id` sessions). It sits behind
the exact same auth, Host-allowlist and rate-limit gates as `/search`, so
remote agents inherit the hardening. stdio via `mdss mcp` remains the default
transport.

**Protocol negotiation & `ping` (issue #197):** `initialize` speaks
`2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05` — the client's
requested version is echoed when supported, otherwise the server answers with
its newest (`2025-11-25`), so modern clients never warn about an outdated
protocol and older clients keep working. `ping` is answered promptly with an
empty result on both transports.

**Sampling — LLM answers via the client (issue #197):** when the client
declares the `sampling` capability at `initialize`, `ask_knowledge_base` hands
the synthesis to the client's own model with a server→client
`sampling/createMessage` request — grounded passages go out, a cited answer
comes back — with **no local LLM and no extra user configuration** (Claude
Desktop sampling, for example). Over stdio the exchange rides the same
stdin/stdout JSON-RPC lines; over HTTP it rides the GET `/mcp` SSE stream with
the answer POSTed back. Sampling is strictly best-effort: a client without the
capability, a refusal, or a timeout (default 60 s, override with
`MDSS_SAMPLING_TIMEOUT_MS`) degrades to the built-in extractive answer. The
tool payload reports which path produced the result in `answerMode`
(`sampling` / `extractive`).

#### Available MCP Tools:
- **`search_markdown`**: Hybrid semantic vector + BM25 search with optional `path` glob, `tag`, rich `filter`, and `graphBoost`.
- **`get_chunk`**: Retrieve a specific section by file and heading.
- **`get_lines`**: Retrieve exact line spans (`fromLine`, `maxLines`) from an indexed Markdown document.
- **`related_notes`**: Find graph-connected (outgoing, backlinks, 2-hop) and semantically related notes for a document.
- **`list_files`**: List indexed Markdown files with chunk counts.
- **`index_status`**: Inspect index health, chunk counts, and model metadata.
- **`ask_knowledge_base`**: Grounded direct Q&A synthesis with citations; uses the client's own LLM via MCP sampling when available (see below), else the built-in extractive answerer — `answerMode` in the payload tells which.
- *All tools return `structuredContent` alongside text and include `readOnly: true, idempotent: true` annotations.*

#### Available MCP Resources & Templates:
- **`mdss://note/{path}`**: Read full content of an indexed Markdown document.
- **`mdss://note/{path}?fromLine=1&maxLines=50`**: Addressable line-span slices of notes.
- **`mdss://vault/{vault}`**: List all indexed notes within a vault.
- **`mdss://status`**: Live index status and chunk count statistics.

#### Available MCP Prompts:
- **`search-and-cite`**: Synthesizes a grounded answer referencing `mdss://note/{path}` resource URIs.
- **`summarize-note`**: Produces a structured summary of core concepts and linked notes.
- **`compare-notes`**: Identifies agreements, divergences, and synergies across two notes.
- **`find-contradictions`**: Audits notes for conflicting statements or outdated ADRs.
- **`timeline`**: Builds a chronological milestone / event timeline from notes.

#### Claude Desktop Configuration:
Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "md-semantic-search": {
      "command": "npx",
      "args": ["-y", "md-semantic-search", "mcp", "--db", "C:\\path\\to\\your\\notes"]
    }
  }
}
```

#### Cursor Configuration (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "md-semantic-search": {
      "command": "npx",
      "args": ["-y", "md-semantic-search", "mcp", "--db", "./notes"]
    }
  }
}
```

### Options

| Flag | Meaning |
|------|---------|
| `--config <file>` | Path to config file (default: `.mdssrc.json`, `mdss.config.json`, `.mdssrc`). |
| `--db <dir>` | Folder of `.md` files (or set `MDSS_DB`). Can be anywhere on disk. |
| `--index-dir <dir>` | Where to store the index (default: `<db>/.mdss`). |
| `--cache-dir <dir>` | Model cache dir. Default: `$XDG_CACHE_HOME/mdss` if set, else `~/.cache/mdss` on **all** platforms (so on Windows that's `C:\Users\<you>\.cache\mdss` — *not* `%LOCALAPPDATA%`; override with `MDSS_CACHE_DIR`). |
| `--model <name\|id>` | Embedding model (default `granite-multilingual-311m`). See `mdss models`. |
| `--workers <n>` | Number of parallel batch workers for embedding (default: 1). |
| `--format <fmt>` | Export format: `jsonl` (default), `csv`, `parquet` (`export`). |
| `--no-vectors` | Omit embeddings from export (`export`). |
| `--output <file>` | Output file path (`export`, default: stdout). |
| `--ignore <glob>` | Skip files/paths; repeatable. e.g. `--ignore "log.md" --ignore "**/archive/**"`. |
| `--path <glob>` | Search only files matching glob; repeatable. e.g. `--path "docs/**"`. |
| `--since <date>` | Search only files modified at/after date (`YYYY-MM-DD` or ISO 8601). |
| `--k <n>` | Number of results, positive integer (default 6). |
| `--json` | Machine-readable output: `index` → build result JSON, `stats` → index stats JSON, `search` → hit list JSON (each hit includes `matches` — the query terms found in the chunk). |
| `--semantic` | `search` only: pure vector ranking, skip lexical/RRF fusion (zero lexical tokenization). |
| `--open [N]` | `search`: open the top (or Nth) hit in your editor at its `startLine` — `$MDSS_EDITOR`/`$VISUAL`/`$EDITOR`, VS Code `--goto`, or the GUI opener. With `--json` on a non-TTY prints the intent instead of launching (issue #110). |
| `--fix` | `check`: apply safe auto-repairs — stale `.mdss.lock`, SHA-mismatched `vectors.bin` sidecar, corrupt `ivf.json`/`hnsw.json`; rebuilds a corrupt index / recomputes `.hashes.json` when `--db` is available. Never touches source notes (issue #117). |
| `--dry-run` | `check --fix`: print the planned repairs without mutating anything. |
| `--rerank` | Re-rank the candidate pool with a cross-encoder (~144 MB default model, downloaded on first use). Slower, sharper results — see *Reranking* below. |
| `--rerank-model <m>` | Reranker registry alias (issue #203): `bge-reranker-base` (default) or `gte-reranker-modernbert` (144 MB, 8k ctx, Apache-2.0); raw `id@revision` accepted. |
| `--multi-query <n>` | Multi-query expansion (issue #203): N query variants (original + N−1 LLM paraphrases) fused by union-RRF; needs `--llm-endpoint`, degrades silently without it. |
| `--min-answer-confidence <n>` | `ask`/`chat`: abstention floor for the extractive answer (0..1, default 0.13) — below it the answer is a refusal with zero citations instead of spurious grounding (issue #238). `0` disables abstention. Env `MDSS_MIN_ANSWER_CONFIDENCE`. |
| `--graph-boost <n>` | Weight for Obsidian wikilink graph ranking and PageRank prior (search; default 0). Incorporates document centrality and 2-hop contextual propagation. |
| `--filter <expr>` | Rich boolean filter across frontmatter tags and properties (e.g. `tag:engineering AND status != archived`). |
| `--ann [ivf\|hnsw\|false]` | Approximate nearest neighbor search (search; auto-enables for large corpora). Engines (issue #201): `ivf` (k-means, the default sidecar) or `hnsw` (graph — no training phase, 100% measured recall at equal-or-lower query latency, `hnsw.json` sidecar, corrupt → brute-force fallback; watch rebuilds reuse the persisted graph via chunk-hash remapping instead of rebuilding it — issue #223). Bare `--ann` prefers an existing sidecar. `--ann false`/`--ann off` (issue #235) forces **exact brute force** — no ANN even when a sidecar exists and the corpus is above the threshold; omitting the flag keeps the automatic threshold behavior. |
| `--nprobe <n>` | Number of nearest centroid clusters to probe during ANN search (default 8). |
| `--port <n>` | HTTP port for `serve` (default 8747, or `MDSS_PORT`). |
| `--host <ip>` | Bind address for `serve` (default `127.0.0.1` — loopback only; use `0.0.0.0` to expose on the LAN, or `MDSS_HOST`). |
| `--api-key <key>` | `serve`: require Bearer auth on every request (`MDSS_API_KEY`). |
| `--api-key-file <path>` | `serve`: read the API key from a file instead of a literal value — avoids shell-history / CI-log leaks (`MDSS_API_KEY_FILE`; trailing newline trimmed, POSIX permissions checked). |
| `--allow-unsecured` | `serve`: explicit opt-in to bind non-loopback **without** auth; without it (and without an API key) such a bind refuses to start (issue #121). |
| `--allowed-host <h>` | `serve`: extra `Host` header value to accept (repeatable); anything else gets `403` — DNS-rebinding guard (issue #120). |
| `--cors-origin <o>` | `serve`: allow cross-origin browser access from this exact origin (repeatable); CORS is off unless set (issue #120). |
| `--trust-proxy <ip\|cidr>` | `serve`: reverse-proxy peers whose `X-Forwarded-For` may be trusted for rate-limit keying (repeatable; exact IP or IPv4 CIDR). Default **off** — the header is spoofable, so without it every client behind one proxy shares one bucket (issue #241). `/health` reports the active keying (`client_key`). |
| `--rate-limit <n>` | `serve`: max `/search` requests per minute per client, burst 10 → `429 + Retry-After` above it; `0` disables (default 60, `MDSS_RATE_LIMIT`; issue #119). |
| `--max-concurrency <n>` | `serve`: max concurrent in-flight searches; queue cap 2× → `503` when full; `0` disables (default = CPU count, `MDSS_MAX_CONCURRENCY`; issue #119). |
| `--watch` | `serve`: re-index incrementally when files change. |
| `--watch-debug` | `serve --watch`: verbose trace of polls, FS-error classifications and retries (issue #116). |
| `--recency <days>` | `search`: time-decay half-life — passages get a `0.5^(age/halfLife)` boost after fusion; age from frontmatter `created`/`updated`, then file mtime; surfaced in `explain` (issue #127). |
| `--embedder <name>` | Use an external embedding provider (`ollama` or `openai`) instead of local transformers.js, together with `--embedder-model` (+ `--embedder-base-url`, `--embedder-key-file`). The provider id/model/dim are recorded in the index — switching providers invalidates vectors with the usual full re-embed. Local remains the zero-config default and the only fully-offline path (issue #124). ⚠️ A non-loopback endpoint receives note content as embedding input — see [SECURITY.md → Data egress](./SECURITY.md#data-egress-issue-183). |
| `--no-query-cache` | `search`: skip the persistent query-embedding cache — repeated queries in fresh processes re-embed otherwise (issue #114). |
| `--no-ui` | `serve`: disable the built-in web UI at `/` — restores JSON API help there (issue #111). |
| `--watch-interval <ms>` | `serve --watch`: poll every N ms (default 3000). |
| `--watch-delay <ms>` | `serve --watch`: quiet-period debounce before a burst of saves triggers ONE re-index (default 1000; issue #42). |
| `--offline` | Never download the model — require a cached one (or `MDSS_OFFLINE=1`). |
| `--version` | Print the installed version. |

### Shell completions

`mdss completions <bash|zsh|fish|powershell>` prints a self-contained completion
script covering every subcommand and flag, with directory completion for
`--db` / `--index-dir` / `--cache-dir` / `--vault` and file completion for
`--output` / `--config` / `--api-key-file`:

```bash
# bash — current session only:
eval "$(mdss completions bash)"
# bash — persistent:
mdss completions bash > ~/.local/share/bash-completions/completions/mdss

# zsh:
mkdir -p ~/.zfunc && mdss completions zsh > ~/.zfunc/_mdss   # fpath before compinit

# fish:
mdss completions fish > ~/.config/fish/completions/mdss.fish

# PowerShell — paste into your $PROFILE:
mdss completions powershell >> $PROFILE
```

A unit test guards against flag drift: the generated tables must match the
flags `parseArgs` actually accepts.

### The base can live outside the project

The index does not need write access to your notes if they're read-only — just
point the index somewhere writable:

```bash
mdss index  --db /mnt/shared/team-wiki --index-dir ~/.cache/team-wiki-index
mdss search --db /mnt/shared/team-wiki --index-dir ~/.cache/team-wiki-index "incident runbook for db failover"
```

Or drive everything from environment variables:

```bash
export MDSS_DB=/mnt/shared/team-wiki
export MDSS_INDEX_DIR=~/.cache/team-wiki-index
mdss index
mdss search "incident runbook for db failover"
```

**Supported layouts** (hardened by the issue #118 suite): deep trees beyond
Windows MAX_PATH (>260 chars) work; unicode and spaces in names work;
`--index-dir` may live on a different drive than `--db`; NTFS junction loops
terminate the walker (bounded by path length); `\\?\` extended-length roots are
accepted for `--db`/`--index-dir`; remote UNC shares (`\\server\share`) are
**rejected** by design (local-only security boundary).

### Configuration file (`.mdssrc` / `mdss.config.json`)

Instead of repeating CLI options on every command, create a `.mdssrc.json` or `mdss.config.json` file.
`mdss` discovers config files by searching:
1. An explicit path passed via `--config <path>` or the `MDSS_CONFIG` environment variable.
2. Current working directory up through ancestor directories (`.mdssrc.json`, `mdss.config.json`, `.mdssrc`).
3. User global config at `~/.mdssrc.json` or `~/.mdssrc`.

CLI flags always override configuration values.

Example `.mdssrc.json`:

```json
{
  "db": "./notes",
  "model": "e5-base",
  "indexDir": "./notes/.mdss",
  "ignore": ["archive/**", "drafts/**"],
  "k": 6
}
```

Run `mdss check` to validate your configuration file schema and detect unknown keys.

## Models

```bash
mdss models
```

| Alias | Model | Dim | Notes |
|-------|-------|-----|-------|
| `e5-small` | `Xenova/multilingual-e5-small` | 384 | Fastest (~120 MB). **Weak cross-lingual** — see RESEARCH. |
| `e5-base` | `Xenova/multilingual-e5-base` | 768 | Default before v2.2.0. Apache-2.0, MIT-style terms. |
| `e5-large` | `Xenova/multilingual-e5-large` | 1024 | ~2.2 GB, higher quality. |
| `bge-m3` | `Xenova/bge-m3` | 1024 | ~2.3 GB. Best cross-lingual separation in tests. |
| `qwen3-embedding-0.6b` | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 1024 | ~613 MB q8. Opt-in; instruction-prefixed queries and last-token pooling. |
| `granite-multilingual-311m` ⭐ | `onnx-community/granite-embedding-311m-multilingual-r2-ONNX` | 768 | **Default.** ~298 MB q8. IBM Granite r2 — ModernBERT 8k context, CLS pooling, **Apache-2.0**. Measured nDCG@10 0.8653 on golden v2 (issue #227). |
| `embeddinggemma-300m` | `onnx-community/embeddinggemma-300m-ONNX` | 768 | ~300 MB q8. Measured leader (nDCG@10 0.8691) but **license-blocked from being the npm default**: Gemma Terms of Use, not MIT/Apache (issue #227). |

Switching models invalidates the stored vectors automatically — the next
`index` run does a full rebuild.

Weights are downloaded in quantized (q8) form when the model repo ships them
(the default granite is ~298 MB).

Why granite is the default (issue #227): measured on the 186-query golden set
v2 against the incumbent e5-base — **granite 0.8653 vs e5-base 0.7874 nDCG@10**
with the same size class and a fully permissive Apache-2.0 license. The strictly
better `embeddinggemma-300m` (0.8691) is a two-thousandths edge over granite but
carries Google's Gemma Terms of Use; making it the npm default would impose
those terms on every user, so it stays the recommended opt-in. Full decision
record and per-category tables: RESEARCH.md §15.

### How to add a model

Every supported model is an *explicit adapter* in `src/models.mjs` (issue #60).
The adapter declares exactly which embedding semantics it needs — the shared
`embed()` path never guesses from the model name:

- `queryPrefix` / `passagePrefix` — text prepended to queries/passages (E5 uses
  `query: `/`passage: `, BGE/Granite none, Qwen3 a retrieval instruction on
  queries, EmbeddingGemma its task/title prefixes);
- `pooling` — `'mean'`, `'last_token'`, `'cls'`, or `'none'`;
- `normalize` — whether vectors are L2-normalized;
- `nativeDim` / `dim` — embedding dimension (and optional `dimensions` for MRL);
- `dtype` — the ONNX runtime data type loaded at runtime (default `q8`);
- `maxTokens` — the tokenizer context budget (Qwen3-0.6B is 32768);
- `pooledOutput` — the ONNX graph already emits a pooled `sentence_embedding`
  (EmbeddingGemma); embedding reads that output directly instead of the
  feature-extraction pipeline;
- `family` — an informational formatting/pooling label surfaced by `stats`.

`mdss models` prints each adapter's pooling, normalization, dimension, and
token budget. `mdss stats` and `mdss check` expose the same adapter fields for
an existing index, plus its `adapterFingerprint`.

**A raw Hugging Face id that is not a registered adapter is rejected at embed
time — it does NOT silently inherit E5 prefixes and mean pooling.** Use a
registered alias (or the explicit object descriptor below):

```bash
mdss index --db ./docs --model "Xenova/multilingual-e5-small@abc123def"
```

Pinned ids invalidate the index too (the revision is part of the model key), so
a `@revision` bump triggers a full rebuild. Custom ids should have quantized
weights (a `model_quantized.onnx` file) in the repo.

Library consumers adding a one-off model can pass an explicit adapter object to
`buildIndex`/`search` instead of editing the registry:

```js
import { buildIndex } from 'md-semantic-search';
await buildIndex({
  db: './docs', indexDir: './.mdss',
  modelName: {
    id: 'Xenova/some-embedding-model',
    nativeDim: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    pooling: 'mean',
    normalize: true,
  },
});
```

Without `queryPrefix`/`passagePrefix`/`pooling`/`dim`, a raw id is still treated
as an unconfigured adapter and indexing fails with a message pointing at this
section instead of silently producing wrong vectors.

## How it works

1. **Walk** `--db` recursively for `.md`/`.markdown` (dotfiles & `--ignore`
   globs skipped).
2. **Chunk** each file by Markdown headings while retaining the active heading
   stack; oversized sections split on blank lines. The budget is in **tokens**
   (issue #202): `min(model maxTokens, 512)` by default with a script-
   calibrated estimator, so Cyrillic notes get the same real budget as English
   ones (the legacy English-calibrated `~1400 chars` budget overflowed the
   model's context for RU ~2×). Override with `--max-chunk-tokens`, or set `0`
   to restore the legacy char budget.
3. **Embed** the document title, full heading path, and chunk body (`passage:`
   prefix for E5) → store `{file, title, heading, headingPath, text, vec}` in
   `vectors.json`, plus per-file md5 in `.hashes.json`. The index stores an
   adapter fingerprint so formatting, pooling, normalization, or dimension
   changes invalidate vectors and checkpoints without invalidating lexical
   records. Each chunk also stores
   `chunkHash` (SHA-256 of that exact contextual passage + model identity), so a
   parent rename invalidates its subtree while unchanged sibling branches reuse
   their vectors.
4. **Search**: embed the query with the selected model's formatter (`query:` for
   E5, no prefix for BGE-M3, or the retrieval instruction for Qwen3), score every
   chunk by cosine,
   score query terms from the persisted BM25 postings, then **fuse with RRF**.
   Legacy schema-v0/v1/v2 indexes retain exact token-overlap scoring.

No external services, no database — the whole index is one JSON file and search
is an in-memory dot-product sweep.

## Integrations

- **Obsidian**: An official plugin is available in [`integrations/obsidian`](./integrations/obsidian) providing a live semantic search panel directly in your vault connected to `mdss serve`.
- **Model Context Protocol (MCP)**: Native stdio JSON-RPC 2.0 server (`mdss mcp`) integrating with Claude Desktop, Cursor, Copilot, Antigravity, and AI agents for local knowledge retrieval.
- **VS Code / Raycast / Alfred**: see [`integrations/README.md`](./integrations/README.md). Releases are automated — tagging `integrations/vscode/vX.Y.Z` builds and attaches the VSIX to a GitHub Release from source (no binaries are committed; issue #112).
- **Windows tray icon**: [`integrations/windows/`](./integrations/windows/) — a zero-dependency system-tray companion for `mdss serve` (pure PowerShell + .NET WinForms, built into Windows): state-colored icon, indexing stats on hover (chunks / model / index age), a balloon when your notes get re-indexed. One-command start:

```cmd
integrations\windows\start-mdss.cmd D:\Notes
```

## Contributing

Contributions are welcome — bug reports with reproduction steps, docs fixes,
tests, and features all help. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md) (dev setup, project tour, conventions)
and look for issues labeled **`good first issue`** — they are scoped for a
first-time contributor. For the internals — module map, data-flow diagrams,
on-disk formats, and extension points — see
[ARCHITECTURE.md](./ARCHITECTURE.md). By participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

MIT © chelslava

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
- 🌍 **Cross-lingual.** Multilingual embeddings (default `multilingual-e5-base`).
- 🧠 **Hybrid ranking.** Reciprocal Rank Fusion of vector similarity (meaning)
  and lexical overlap (exact names like `win32`, `TextIOWrapper`).
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

## Requirements

- Node.js ≥ 18
- ~280 MB disk for the default model (downloaded once into a cache dir)

## Install

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

## Usage

### 1. Build the index

```bash
mdss index --db /path/to/your/markdown
```

First run downloads the model (~280 MB). The index is written to `<db>/.mdss/`
by default (override with `--index-dir`). Re-run after editing your notes — it's
incremental at two levels: unchanged files are skipped via their md5, and inside
a changed file only the sections whose text actually changed are re-embedded
(chunks carry a `chunkHash` in `vectors.json`; an append to a long log re-embeds
just the new entry). The index output reports the split, e.g.:

```
Indexed 64 file(s) → 725 chunks (725 reused [5 chunk-level, 720 file-level], 0 embedded), ... 0.6s
```

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
#   chunks: 725 · files: 64
#   size: 42.1 KiB (vectors.json)
#   built: 2026-08-08T09:42:58.331Z (2m 12s ago)
#   db: /path/to/your/markdown
```

`mdss stats --json` prints machine-readable JSON: `indexDir`, `format`
(`binary-v1` vs legacy `decimal`), `model` (id@revision) / `modelAlias`, `dim`,
`chunks`, `files`, `indexBytes`, `built`, `ageSeconds`, `db`.

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

The default ranking scores each chunk *independently* (vector cosine + lexical
overlap fused with RRF). A **cross-encoder** instead reads the query and the
passage **together**, capturing pairwise relevance that independent scores can
miss — at the cost of one forward pass per candidate.

```bash
mdss search --db /path/to/your/markdown "how do I rotate the api token" --rerank
```

- The first pass pulls a wider candidate pool (default `max(20, k*3)` chunks),
  the cross-encoder (`Xenova/bge-reranker-base`, ~280 MB, downloaded on first
  use) re-scores them as query↔passage pairs, and the best `k` survive.
- Results from a re-ranked search carry a `rerankScore` field in `--json` mode.
- Programmatic use: `rerank: true` in `search()`/`searchIndex()`, `rerankPool`
  to size the pool, or `rerankFn` to swap in your own scorer. The API server
  accepts `"rerank": true` in the `/search` body.
- The reranker is lazy: nothing loads unless `--rerank` is actually requested,
  so searches without it pay zero extra cost.


### 3. Serve (daemon, warm index + model)

```bash
mdss serve --db /path/to/your/markdown [--port 8747] [--host 127.0.0.1] [--watch]
```

`serve` is the long-running mode for editors, scripts, or anything that asks
many questions in a row: the index is parsed **once** and the embedding model
stays loaded in memory, so every request skips the ~280 MB model load and the
full `vectors.json` parse. `--watch` polls the base for file changes (mtime,
no extra dependencies) and re-runs the incremental re-index automatically.

```bash
# query it with curl…
curl -X POST localhost:8747/search -d '{"query":"rotate api token","k":5}'
curl localhost:8747/health          # → {ok, chunks, model, dim, built, watching}
```

Or from a script / editor extension:

```js
const r = await fetch('http://localhost:8747/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'failover runbook', k: 3 }),
});
const { results } = await r.json();
```

The API is unauthenticated — by default it binds to **loopback only**
(`127.0.0.1`), so other machines on your LAN cannot reach it. Pass `--host
0.0.0.0` (or `MDSS_HOST`) only if you intend to expose it on a network, and put
a reverse proxy (or at least a firewall rule) in front of it. Request bodies
are capped at 64 KB (oversized → `413`), and malformed JSON gets a clear `400`
instead of being silently swallowed.

### Options

| Flag | Meaning |
|------|---------|
| `--db <dir>` | Folder of `.md` files (or set `MDSS_DB`). Can be anywhere on disk. |
| `--index-dir <dir>` | Where to store the index (default: `<db>/.mdss`). |
| `--cache-dir <dir>` | Model cache dir (default: `$XDG_CACHE_HOME/mdss` → `~/.cache/mdss`, or `%LOCALAPPDATA%\mdss` on Windows; override with `MDSS_CACHE_DIR`). |
| `--model <name\|id>` | Embedding model (default `e5-base`). See `mdss models`. |
| `--ignore <glob>` | Skip files/paths; repeatable. e.g. `--ignore "log.md" --ignore "**/archive/**"`. |
| `--path <glob>` | Search only files matching glob; repeatable. e.g. `--path "docs/**"`. |
| `--since <date>` | Search only files modified at/after date (`YYYY-MM-DD` or ISO 8601). |
| `--k <n>` | Number of results, positive integer (default 6). |
| `--json` | Machine-readable output: `index` → build result JSON, `stats` → index stats JSON, `search` → hit list JSON (each hit includes `matches` — the query terms found in the chunk). |
| `--semantic` | Pure vector ranking, skip lexical fusion. |
| `--rerank` | Re-rank the candidate pool with a cross-encoder (`Xenova/bge-reranker-base`, ~280 MB model, downloaded on first use). Slower, sharper results — see *Reranking* below. |
| `--port <n>` | HTTP port for `serve` (default 8747, or `MDSS_PORT`). |
| `--host <ip>` | Bind address for `serve` (default `127.0.0.1` — loopback only; use `0.0.0.0` to expose on the LAN, or `MDSS_HOST`). |
| `--watch` | `serve`: re-index incrementally when files change (mtime poll). |
| `--offline` | Never download the model — require a cached one (or `MDSS_OFFLINE=1`). |
| `--version` | Print the installed version. |

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

## Models

```bash
mdss models
```

| Alias | Model | Dim | Notes |
|-------|-------|-----|-------|
| `e5-small` | `Xenova/multilingual-e5-small` | 384 | Fastest (~120 MB). **Weak cross-lingual** — see RESEARCH. |
| `e5-base` ⭐ | `Xenova/multilingual-e5-base` | 768 | Default. Best balance. |
| `e5-large` | `Xenova/multilingual-e5-large` | 1024 | ~2.2 GB, higher quality. |
| `bge-m3` | `Xenova/bge-m3` | 1024 | ~2.3 GB. Best cross-lingual separation in tests. |

Switching models invalidates the stored vectors automatically — the next
`index` run does a full rebuild.

Weights are downloaded in quantized (q8) form when the model repo ships them
(all `Xenova/*` repos do — e5-base is ~280 MB, not ~1.1 GB fp32).

You can also pass any raw `Xenova/*` id, optionally pinning a revision:

```bash
mdss index --db ./docs --model "Xenova/multilingual-e5-small@abc123def"
```

Pinned ids invalidate the index too (the revision is part of the model key), so
a `@revision` bump triggers a full rebuild. Custom ids should have quantized
weights (a `model_quantized.onnx` file) in the repo.

## How it works

1. **Walk** `--db` recursively for `.md`/`.markdown` (dotfiles & `--ignore`
   globs skipped).
2. **Chunk** each file by Markdown headings; oversized sections split on blank
   lines (~1400 chars/chunk).
3. **Embed** each chunk (`passage:` prefix for E5) → store `{file, heading,
   text, vec}` in `vectors.json`, plus per-file md5 in `.hashes.json`. Each chunk
   also stores `chunkHash` (SHA-256 of the exact passage input + model identity),
   so on re-index an unchanged section inside a modified file reuses its vector
   instead of being embedded again.
4. **Search**: embed the query (`query:` prefix), score every chunk by cosine,
   score by lexical term-overlap, then **fuse with RRF**. Return top-k chunks.

No external services, no database — the whole index is one JSON file and search
is an in-memory dot-product sweep.

## License

MIT © chelslava

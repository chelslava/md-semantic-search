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
- ⚡ **Incremental.** Per-file md5 — re-indexing only re-embeds changed files.
- 🔒 **Private & offline.** Model downloads once, then no network. Nothing is
  uploaded anywhere.
- 📦 **Zero infra.** One JSON index, brute-force cosine in memory. No Pinecone,
  no Qdrant, no pgvector. Scales fine to thousands of chunks.

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

## Usage

### 1. Build the index

```bash
mdss index --db /path/to/your/markdown
```

First run downloads the model (~280 MB). The index is written to `<db>/.mdss/`
by default (override with `--index-dir`). Re-run after editing your notes — it's
incremental, so only changed files are re-embedded.

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

### Options

| Flag | Meaning |
|------|---------|
| `--db <dir>` | Folder of `.md` files (or set `MDSS_DB`). Can be anywhere on disk. |
| `--index-dir <dir>` | Where to store the index (default: `<db>/.mdss`). |
| `--cache-dir <dir>` | Model cache dir (default: package `.cache`, or `MDSS_CACHE_DIR`). |
| `--model <name\|id>` | Embedding model (default `e5-base`). See `mdss models`. |
| `--ignore <glob>` | Skip files/paths; repeatable. e.g. `--ignore "log.md" --ignore "**/archive/**"`. |
| `--k <n>` | Number of results (default 6). |
| `--json` | Machine-readable output. |
| `--semantic` | Pure vector ranking, skip lexical fusion. |

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
`index` run does a full rebuild. You can also pass any raw `Xenova/*` id.

## How it works

1. **Walk** `--db` recursively for `.md`/`.markdown` (dotfiles & `--ignore`
   globs skipped).
2. **Chunk** each file by Markdown headings; oversized sections split on blank
   lines (~1400 chars/chunk).
3. **Embed** each chunk (`passage:` prefix for E5) → store `{file, heading,
   text, vec}` in `vectors.json`, plus per-file md5 in `.hashes.json`.
4. **Search**: embed the query (`query:` prefix), score every chunk by cosine,
   score by lexical term-overlap, then **fuse with RRF**. Return top-k chunks.

No external services, no database — the whole index is one JSON file and search
is an in-memory dot-product sweep.

## License

MIT © chelslava

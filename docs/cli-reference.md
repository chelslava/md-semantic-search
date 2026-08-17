# CLI Reference

This document is automatically generated from `mdss --help`.

```text
md-semantic-search (mdss) — local, private semantic search over Markdown

Usage:
  mdss index  --db <dir> [options]            Build/refresh the index
  mdss stats  --db <dir> [--json]             Index stats without loading the model
  mdss check  --db <dir> [--json]             Diagnose index/db/model cache (alias: doctor)
  mdss export --db <dir> [options]            Export index to JSONL / CSV / Parquet
  mdss search --db <dir> [options] "query"    Search by meaning
  mdss serve  --db <dir> [--port <n>] [--host <ip>] [--watch]  Daemon: warm model + index
  mdss mcp    --db <dir> [--list-tools]       Start MCP server over stdio for LLM agents / IDEs
  mdss models                                  List available models

Options:
  --config <file>     Path to config file (default: .mdssrc.json / mdss.config.json).
  --db <dir>          Folder of .md files (or env MDSS_DB). Can be anywhere.
  --index-dir <dir>   Where to store the index (default: <db>/.mdss).
  --cache-dir <dir>   Model cache dir (default: ~/.cache/mdss, or MDSS_CACHE_DIR).
  --model <name|id>   Embedding model (default: e5-base). See `mdss models`.
  --workers <n>       Number of parallel batch workers for indexing (default: 1).
  --format <fmt>      Export format: jsonl (default), csv, parquet (export).
  --no-vectors        Omit vector embeddings from export (export).
  --output <file>     Output file path (export, default: stdout).
  --ignore <glob>     Skip files/paths (repeatable). e.g. --ignore "log.md".
  --path <glob>       Search only files matching glob (repeatable). e.g. --path "docs/**".
  --since <date>      Search only files modified at/after date (YYYY-MM-DD or ISO).
  --k <n>             Number of results (search, default 6).
  --json              Machine-readable output (index, stats, search).
  --semantic          Pure vector ranking, skip lexical/RRF fusion (search).
  --rerank            Re-rank candidates with a cross-encoder (search; ~280MB model).
  --ann               Approximate nearest neighbor search via IVF (search).
  --nprobe <n>        Number of centroids to probe for ANN (search, default: 8).
  --port <n>          HTTP port for serve (default: 8747).
  --host <ip>         Bind address for serve (default: 127.0.0.1 — loopback
                      only; use 0.0.0.0 to expose on the LAN, env MDSS_HOST).
  --watch             serve: re-index incrementally on file changes (mtime poll).
  --watch-interval <ms>  serve --watch: poll every N ms (default 3000).
  --watch-delay <ms>     serve --watch: quiet-period debounce before a burst of
                         saves triggers ONE re-index (default 1000; issue #42).
  --offline           Never download the model; require a cached one (env MDSS_OFFLINE=1).
  --version           Print the version and exit.
  -h, --help          Show this help.

Examples:
  mdss index  --db ./docs
  mdss index  --db /abs/path/to/wiki --model bge-m3 --ignore "log.md" --ignore "**/archive/**"
  mdss search --db ./docs "how do I rotate the api token"
  MDSS_DB=./docs mdss search "rollback a failed migration" --k 8 --json
  mdss search --db ./docs "incident runbook" --path "docs/**" --since 2026-01-01
  mdss serve  --db ./docs --port 8747 --watch
  curl -X POST localhost:8747/search -d '{"query":"rotate api token","k":5}'
```

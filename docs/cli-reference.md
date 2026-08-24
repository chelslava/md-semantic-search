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
  mdss completions <bash|zsh|fish|powershell>  Print a self-contained shell completion script

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
  --graph-boost <n>   Boost weight for graph PageRank / Obsidian wikilinks (search, default: 0).
  --filter <expr>     Rich boolean filter across frontmatter tags and properties (search).
  --ann               Approximate nearest neighbor search via IVF (search).
  --nprobe <n>        Number of centroids to probe for ANN (search, default: 8).
  --port <n>          HTTP port for serve (default: 8747).
  --host <ip>         Bind address for serve (default: 127.0.0.1 — loopback
                      only; use 0.0.0.0 to expose on the LAN, env MDSS_HOST).
  --api-key <key>     Require Bearer auth on every request (env MDSS_API_KEY).
  --api-key-file <p>  Read the API key from a file instead of a literal value —
                      avoids shell-history/CI-log leaks (env MDSS_API_KEY_FILE;
                      trailing newline trimmed, POSIX chmod-checked).
  --allow-unsecured   Explicit opt-in to serve non-loopback WITHOUT auth — a loud
                      banner is printed; without it (and without an api key) a
                      non-loopback bind refuses to start (issue #121).
  --allowed-host <h>  Extra Host header value to accept (repeatable) — requests
                      naming any other Host get 403 (DNS-rebinding guard, issue #120).
  --cors-origin <o>   Allow cross-origin browser access from this exact origin
                      (repeatable); CORS is off unless set, and only exact
                      matches are reflected with Vary: Origin (issue #120).
  --rate-limit <n>    serve: max /search requests per minute per client, burst
                      10 → 429 + Retry-After above it; 0 disables (default 60,
                      env MDSS_RATE_LIMIT; issue #119).
  --max-concurrency <n>  serve: max concurrent in-flight searches, queue cap
                      2× → 503 when full; 0 disables (default = CPU count,
                      env MDSS_MAX_CONCURRENCY; issue #119).
  --watch             serve: re-index incrementally on file changes (mtime poll).
  --no-ui             serve: disable the built-in web UI at the root path
                      (issue #111) - the JSON API help is served there instead.
  --mcp               serve: also mount Streamable HTTP MCP at /mcp
                      (issue #123) - same auth/host/rate-limit gates as
                      /search; stdio via the mcp command remains default.
  --watch-debug       serve --watch: verbose trace of polls, FS-error
                      classifications and retries (issue #116).
  --watch-interval <ms>  serve --watch: poll every N ms (default 3000).
  --watch-delay <ms>     serve --watch: quiet-period debounce before a burst of
                         saves triggers ONE re-index (default 1000; issue #42).
  --offline           Never download the model; require a cached one (env MDSS_OFFLINE=1).
  --no-query-cache    search: skip the persistent query-embedding cache
                      (<cacheDir>/query-cache.json, issue #114); in-memory
                      caching stays on.
  --recency <days>    search: time-decay half-life — fresher passages get
                      0.5^(age/halfLife) boost post-fusion (frontmatter
                      created/updated, then file mtime; issue #127).
  --embedder <name>   Use an EXTERNAL embedding provider instead of local
                      transformers.js: "ollama" or "openai" (issue #124).
                      Local stays the zero-config default and the only
                      fully-offline path.
  --embedder-model <m>   Provider-side model (e.g. nomic-embed-text).
  --embedder-base-url <u>  Endpoint (default: OLLAMA_HOST /
                      http://127.0.0.1:11434 for ollama,
                      https://api.openai.com/v1 for openai).
  --embedder-key-file <p>  Bearer key file for openai-compatible endpoints
                      (or OPENAI_API_KEY env).
  --expand <mode>     search: query expansion - "prf" (offline pseudo-
                      relevance feedback: top passages feed salient terms,
                      ONE embed total; issue #125) or "hyde" (LLM-generated
                      passage via --llm-endpoint; degrades silently without it).
  --expand-passages <n>  prf feedback pool size (default 3, max 20).
  --open [N]          search: open the top (or Nth) hit in your editor at its
                      startLine — MDSS_EDITOR/VISUAL/EDITOR, then VS Code
                      --goto, then the GUI opener (issue #110). With --json on
                      a non-TTY prints what WOULD be opened instead of launching.
  --fix               check: apply safe auto-repairs (stale lock, broken
                      vectors.bin sidecar, stale ivf.json); never touches notes.
  --dry-run           check --fix: print planned repairs without mutating.
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

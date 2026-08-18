# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-08-18

### Added
- **Issue #101** — Offline QA & Answer Synthesis CLI (`mdss ask`) with Local LLM.
  - Dedicated RAG module (`src/rag.ts`) supporting local LLM bridges (Ollama / LocalAI / OpenAI endpoints) and an offline extractive answer synthesizer (`extractAnswerFallback`).
  - Strict citation attribution (`[file#heading]`) for all synthesized answers.
  - New `mdss ask "<question>"` CLI command and `ask_knowledge_base` MCP tool.
- **Issue #102** — Interactive RAG Chat Mode in Terminal TUI (`mdss tui --rag`).
  - Multi-turn interactive conversation pane in TUI with Tab toggle between raw passages and synthesized answer.
- **Issue #103** — Automated Note Summarization & Semantic Keyword Tagging Pipeline.
  - Statistical keyphrase extraction (`extractKeyphraseTags`) and extractive passage summarizer (`summarizePassage`, `analyzeNote`) in `src/summarize.ts`.
  - Added `--auto-tag` and `--auto-summarize` CLI indexing flags.

## [0.8.0] - 2026-08-18

### Added
- **Issue #98** — Official VS Code Extension (`integrations/vscode/`).
  - Native extension manifest and bundle with `MDSS: Semantic Search Notes` QuickPick command.
  - Interactive sidebar Webview panel (`mdss-search-view`) with live Markdown preview.
  - Click-to-open heading and line navigation (`editor.revealRange`) directly in the active editor.
- **Issue #99** — Desktop Launcher Extensions for Raycast and Alfred (`integrations/`).
  - Raycast React extension (`integrations/raycast/`) with List/Detail view and copy/open actions against local `mdss serve` daemon.
  - Alfred 4/5 Script Filter (`integrations/alfred/`) outputting structured JSON items with QuickLook support.
- **Issue #100** — OS-Native File Watcher with Zero-Polling Kernel Events (`src/watcher.ts`).
  - Kernel event listener (`ReadDirectoryChangesW`, `fsevents`, `inotify`) via recursive `fs.watch`.
  - Zero idle background disk I/O on large multi-thousand-note repositories with burst debouncing and graceful interval polling fallback.
  - Exported `createFileWatcher` and integrated into `mdss serve --watch`.

## [0.7.0] - 2026-08-18

### Added
- **Issue #95** — Zero-Copy Binary Index Storage (`vectors.bin`).
  - Monolithic binary storage format with 64-byte aligned `MDSSBIN1` header (`src/binary-format.ts`).
  - Direct zero-copy memory mapping via `Float32Array` / `Int8Array` buffer views without base64 decoding or per-chunk array allocations.
  - Seamless backward-compatible fallback to `vectors.json`.
- **Issue #96** — Int8 Scalar & Product Quantization Tier.
  - 8-bit scalar quantization module (`src/quantization.ts`) mapping normalized float vectors $[-1.0, 1.0]$ to $[-128, 127]$ `Int8Array`.
  - Fast vectorized asymmetric cosine calculation (`asymmetricCosineInt8` for Float32 query $\times$ Int8 chunk) with $<1\%$ nDCG ranking loss.
  - 4x storage and RAM savings for vector sections (`--quantize int8` in CLI and `buildIndex`).
- **Issue #97** — Multi-Vault & Multi-Repository Search Federation.
  - Federated search module (`src/federation.ts`, `searchFederated`) querying multiple independent vault indexes in parallel.
  - Cross-vault result fusion via calibrated Reciprocal Rank Fusion (RRF) with vault attribution (`vault`, `vaultPath`).
  - Repeatable CLI flag `--vault <dir>` and MCP `search_markdown` tool `vaults` parameter.

## [0.6.0] - 2026-08-18

### Added
- **Issue #92** — Graph-Augmented Ranking via Obsidian Wikilinks & PageRank Prior.
  - In-memory PageRank calculation (`computePageRank`) with handling of dangling nodes, cyclical references, and normalization over the vault wikilink graph (`[[note]]`).
  - 2-hop contextual relevance expansion (`expandGraphNeighborhood`) with exponential distance decay.
  - Multi-channel weighted RRF fusion with `--graph-boost <n>` CLI flag, HTTP daemon `POST /search`, and MCP tool parameter.
  - Transparent relevance inspection: `SearchResultHit.explain` and hit fields expose `graphScore` and `pageRank`.
- **Issue #93** — Contextual Chunking 2.0 with Document Metadata & Protected Blocks.
  - Anthropic-style contextual injection: prepends document title, ancestor `headingPath` breadcrumbs, and frontmatter tags into `canonicalPassage` embedding inputs while preserving clean user snippet rendering.
  - Protected Markdown block parser: ensures fenced code blocks (```` ```lang ````) and Markdown tables remain syntactically intact across chunk splits with preserved fences and table header rows.
- **Issue #94** — Rich Frontmatter & Tag Filter Expression DSL.
  - Zero-dependency boolean expression tokenizer, AST parser, and evaluator (`tokenizeFilter`, `parseFilter`, `evaluateFilter`).
  - Supports logical operators (`AND`, `OR`, `NOT`, `!`), grouping parentheses `( ... )`, numeric/date comparisons (`=`, `!=`, `>`, `>=`, `<`, `<=`), and tag containment (`tag:engineering`, `tags contains core`).
  - Exposes `--filter "<expr>"` in CLI `search`, `POST /search` daemon endpoint, and MCP `search_markdown` tool.

## [0.5.0] - 2026-08-17

### Added
- **Issue #81** — parallel batch embedding with concurrency workers (`--workers <n>`, `BuildIndexOptions.workers`). Batches chunks in slices of 32 and executes concurrently across worker promises while preserving atomic checkpointing and progress callbacks.
- **Issue #80** — pure-TypeScript Spherical K-Means IVF approximate nearest-neighbor tier (`src/ivf.ts`). Prunes candidate chunks via centroid probes (`--ann`, `--nprobe`), achieving Recall@10 $\ge 0.95$ on 100k+ chunk corpora with base64 encoded centroid persistence (`ivf.json`).
- **Issue #69** — official Obsidian plugin (`integrations/obsidian/`) providing a live semantic vector search sidebar panel, deep note heading jump (`note.md#Heading`), cosine score preview, and full settings tab.
- **Issue #67** — dedicated documentation site (`docs/`, `scripts/build-docs.mjs`, `npm run docs:build`) with automated GitHub Pages deployment (`.github/workflows/docs.yml`).
- **Issue #64** — interactive terminal UI search mode (`mdss -i`, `mdss --interactive`, `mdss tui`) with live search input, keyboard navigation, and split-screen passage preview.
- **Issue #71** — full TypeScript codebase migration (`src/*.ts` + `tsconfig.build.json` targeting NodeNext ESM output to `dist/*.js` and `dist/*.d.ts`).
- **Issue #72** — Obsidian wikilink extraction and backlink graph indexing (`extractLinks`, `buildRelationshipGraph`, `getRelatedNotes`).
- **Issue #73** — property-based invariant test suite with `fast-check` for tokenizer, cosine metrics, and structural markdown chunking.
- **Issue #63** — HTTP daemon security with Bearer token authentication (`--api-key`, `MDSS_API_KEY`) and optional unauthenticated `/health` probing (`--health-public`).
- **Issue #62** — index export command (`mdss export`) to JSONL (with decoded vector floats), CSV, and Parquet.
- **Issue #59** — configuration file auto-discovery (`.mdssrc`, `.mdssrc.json`, `mdss.config.json`) with directory hierarchy lookup and homedir fallback.
- **Issue #58** — live progress reporting during indexing with percentage, ETA, and chunks/sec throughput indicator.
- **Issue #56** — reproducible golden-set benchmark. A frozen synthetic RU/EN
  corpus (`bench/corpus/`, 16 files / 8 topics × 2 languages) plus graded
  relevance judgements (`bench/fixtures/dev-golden.json`, 60 queries across six
  categories — natural-question, paraphrase, keyword, alias, hard-negative,
  identifier — 48 dev / 8 test / 4 holdout, pinned corpus fingerprint). New
  `bench/fixture.mjs` (schema-v1 validator: `loadFixture`, deterministic
  `corpusFingerprint`, `splitIntoSlices`) and `src/metrics.mjs` (pure,
  dependency-free nDCG@k with log2 discount, MRR, Hit@k, Recall@k,
  `queryMetrics`/`aggregateMetrics`, win/tie/loss). New `scripts/run-bench.mjs`
  builds the index over the frozen corpus, evaluates the selected slice, and
  prints aggregate + per-category metrics; `--fake` swaps in a deterministic
  hash embedder so CI smoke stays network-free (new `golden-smoke` job).
  Baseline on dev (e5-base, hybrid RRF, k=10): nDCG 0.9254, MRR 0.9167,
  Hit@10 0.9792, Recall@10 1.0000. RESEARCH.md documents the methodology and
  baseline. Closes #56 and unblocks the #50 opt-in model benchmark gate.
- **Issue #55 (partial — repo side)** — release provenance verification. New
  `scripts/verify-pack.mjs` packs the npm artifact into an isolated prefix,
  installs it, and smokes the **installed** `mdss` shim: `--version` must equal
  the packaged `package.json` version, `--help` must expose the current
  commands/options (`index`, `search`, `stats`, `check`, `serve`, `models`,
  `--rerank`, `--offline`, `--json`, `--version`), and the installed library
  must export the documented public API. An opt-in real-model smoke
  (`MDSS_RUN_REAL_MODEL=1`) additionally builds a real e5-small index through
  the installed CLI and asserts `stats --json` reports `schemaVersion: 3` and
  `lexicalFormat: bm25-v2` and `check --json` is healthy. The push/PR `ci`
  workflow runs the fast structural smoke; the scheduled `nightly` workflow
  runs the real-model smoke reusing the cached model. Remaining dogfood/install
  side of #55 (updating the global central-KB artifact and rebuilding its
  index) is tracked outside this repo.
- **Issue #60** — explicit embedding-model adapter contract. Every registered
  model (`e5-small/base/large`, `bge-m3`, `qwen3-embedding-0.6b`) now declares
  its adapter in `src/models.mjs`: `queryPrefix`/`passagePrefix`, `pooling`,
  `normalize`, `nativeDim` (+ optional `dimensions` MRL policy), `dtype`,
  `maxTokens`, and a `family` label. `prepareEmbeddingRequest`/`embed` read all
  vector-producing semantics from the adapter and never infer them from the
  model name; `getExtractor` loads the adapter-declared `dtype` (default `q8`).
  A raw Hugging Face id that is not a registered adapter is no longer guessed to
  be E5-compatible — it resolves to a neutral descriptor that fails at embed
  time with an actionable message, and `resolveModel` accepts an explicit adapter
  object for library consumers. The `adapter-v1` fingerprint is unchanged for
  E5/BGE, so existing schema-v3 indexes and checkpoints keep their vectors
  reusable. `mdss models`/`stats`/`check` now surface pooling, normalization,
  dimension, formatting family, and the adapter fingerprint. Issue #50 is no
  longer blocked by #60; it remains open pending the #55 provenance gate and
  the #56 paired RU/EN benchmark.
- **Issue #50 (partial, experimental)** — added the pinned
  `qwen3-embedding-0.6b` model profile
  (`onnx-community/Qwen3-Embedding-0.6B-ONNX`, 1024 dimensions, q8). The
  profile applies Qwen3's query-only retrieval instruction and last-token
  pooling; exact registered raw IDs inherit the pinned profile unless an
  explicit `@revision` overrides it. Pinned offline loads use the existing
  Transformers.js revision directory, and adapter fingerprints prevent
  incompatible vector/checkpoint reuse while preserving model-independent
  lexical reuse. `e5-base` remains the default. Issue #50 stays open pending
  the #55 provenance gate and the #56 paired RU/EN benchmark.
- **Issue #49** — schema-v3 BM25 lexical documents now include the full active
  Markdown heading path, so exact parent-section terms can promote the correct
  nested chunk even when body terms are shared. New builds write `bm25-v2`;
  existing `bm25-v1` indexes remain searchable and perform one lexical-only
  upgrade on the next build while reusing vectors. RRF now gives tied scores
  equal rank contributions instead of letting source order cancel a lexical win.
- **Issue #47** — schema-v3 embeds a pure-JavaScript BM25 inverted index in
  `vectors.json`. Current indexes score and produce matches from postings while
  tokenizing only the query; schema-v0/v1/v2 retain the legacy token-overlap
  lane. Incremental builds reuse lexical records through a model-independent
  lexical-document identity. Legacy loaders preserve their visible schema, so
  transferred/cloned `{index, model}` state still selects overlap without
  process-local metadata. Checkpoints/load/check/stats share fail-closed current
  envelope, vector, and dimension validation with actionable hints.
- **Issue #48** — schema-v2 chunks now retain the full Markdown heading path.
  Embedding and `chunkHash` share one canonical title/path/body passage, so
  nested content is searchable by parent topics and a parent rename re-embeds
  only its subtree. Schema-v0/v1 indexes remain searchable and perform one
  mandatory contextual rebuild on the next `index` run; public search/CLI hit
  shapes are unchanged.
- **Issue #44** — a scheduled/manual nightly CI smoke suite now downloads and
  exercises the real Transformers.js models end to end: e5-small index/search/
  serve with binary-vector integrity checks, real BGE reranking, and a bounded
  uncached `--offline` CLI failure. The fast push/PR `npm test` suite remains
  network-free through an explicit nightly-only opt-in guard.
- **Issue #17 (partial; upstream blocked)** — CI now reports production
  dependency advisories through a non-blocking `npm audit --omit=dev` job, and
  `SECURITY.md` documents reachability, mitigations, and the Node 18 constraint.
  The issue remains open until the upstream Transformers.js dependency tree has
  no high-severity findings.
- **Issue #8** — CLI argument validation: `--k` must be a positive integer,
  missing option values are reported (`error: missing value for <flag>`),
  unknown flags fail fast instead of being silently ignored, and `--version`
  prints the package version.
- **Issue #9** — model cache now defaults to a user-writable location:
  `$XDG_CACHE_HOME/mdss`, falling back to `~/.cache/mdss` on every platform
  (including Windows), instead of the package dir.
- **Issue #10** — repo hygiene: `// @ts-check` + `tsc --noEmit` type checking
  (`npm run lint`) wired into CI, and this `CHANGELOG.md`.
- **Issue #4** — binary vector storage: `vec` is now a base64 `Float32Array`
  blob (`format: "binary-v1"`), ~3.2× smaller indexes and ~12× faster loads on
  a real corpus. Legacy decimal indexes are read transparently and migrated
  on the next `index` run.
- **Issue #14** — stable library API: `"exports"` map + `src/index.mjs` facade
  exposing `buildIndex`, `search`, `loadIndex`, `searchIndex`, `resolveModel`,
  `MODELS` and the low-level helpers, with JSDoc types (works with `checkJs`).
- **Issue #2** — in-process caching for library consumers: `loadIndex()`
  parses `vectors.json` once and `searchIndex()` reuses the chunks across
  queries; the embedding extractor is cached per model id, so repeated
  searches in one process skip both the file read and the model load.
- **Issue #15** — optional cross-encoder re-ranking: `--rerank` (CLI) or
  `rerank: true` (API/HTTP) re-scores the top candidates as query↔passage
  pairs with `Xenova/bge-reranker-base`, then keeps the best `k`. The reranker
  is lazy-loaded on first use (exported as `getReranker`/`rerankScores`);
  candidate pool size is capped by `rerankPool` (default `max(20, k*3)`).
  Re-ranked results gain a `rerankScore` field.
- **Issue #21** — `mdss stats` prints machine-readable index statistics
  (format, model, dim, chunk/file counts, index size, build time, age, db)
  by parsing only `vectors.json` + `.hashes.json` — no model load, no network.
  Human-friendly by default; `--json` for scripts/CI. `mdss index --json` emits
  the `buildIndex` return value (`files`, `chunks`, `reused`, `embedded`, …) as
  JSON instead of the stderr prose, so automation can assert a fully
  incremental re-index ("0 embedded").
- **Issue #39** — `vectors.json` now carries an explicit `schemaVersion`
  (`SCHEMA_VERSION` in `core.mjs`) plus a migration table
  (`SCHEMA_MIGRATIONS`). Reading or re-indexing over an index written by a
  NEWER mdss is a hard, clear error ("upgrade md-semantic-search") instead of
  a silent misparse; legacy pre-version indexes are read transparently and
  stamped on the next `index` run. Every future format change must bump the
  version and add a migration test.
- **Issue #40** — corrupt vectors are caught at load instead of silently
  producing NaN scores: `decodeVec` rejects truncated base64 (byte length not
  a multiple of 4) and non-finite values (NaN/Infinity); `loadIndex` validates
  every chunk's vector length against `index.dim` (falling back to the model
  dim) and names the offending chunk in the error. During a re-index a corrupt
  vector in the old index is dropped with a warning and re-embedded rather
  than aborting the build.
- **Issue #38** — long index builds now atomically checkpoint embedding progress
  every eight batches (about 256 chunks) to `.checkpoint.json`. An interrupted
  build resumes from the compatible sidecar while `vectors.json` and
  `.hashes.json` remain the last complete searchable generation; the sidecar is
  removed after successful publication. No CLI or canonical format change.

### Changed
- **Issue #35** — `buildIndex` no longer reads a changed file twice: `parseFile`
  accepts an optional pre-read `raw` content argument (issue #36 already reads
  every file once for the md5 fast-path check), so re-indexing a changed file
  is now a single disk read instead of two — most relevant on big corpora and
  slow/network disks, and it halves the window for mid-file read errors. The
  public `parseFile(absPath, dbDir, maxChunk)` signature still works unchanged.
- **Issue #6** — `chunkHash` no longer includes the CLI model *alias*, only the
  resolved model id + passage prefix. The same model spelled as alias or raw id
  now produces identical hashes. NOTE: this invalidates stored chunk hashes, so
  upgrading to 0.4.0 triggers a one-time full re-index.
- **Issue #7** — lexical ranking no longer treats content words as stop-words
  (`код`/`кода` removed) and switched from substring matching to exact
  token-overlap scoring (`win` no longer matches `window`).

### Fixed
- **Issue #29** — production paths now have test coverage: `bin/cli.mjs` exports
  its pure functions (`parseArgs`, `nextInt`, `nextValue`, `resolveDb`,
  `resolveIndexDir`, `resolveCache`, `resolveOffline`, `die`) and guards `main()`
  so importing the module never runs the CLI. New `test/cli.test.mjs` (19 tests)
  unit-tests argument parsing, flag/env precedence (`MDSS_DB`, `MDSS_INDEX_DIR`,
  `MDSS_CACHE_DIR`, `MDSS_OFFLINE`), and `die()` error messages, plus a
  subprocess harness asserting real exit codes + stderr for `--version`,
  `--help`, `models`, unknown command/option, `--db /nope`, `--k abc`, missing
  `--db`, and `MDSS_DB` env fallback. The `serve` production path (no injected
  `embedFn`/`rerankFn`) was already asserted in `serve.test.mjs` (#23). The
  exports-map test in `test/lib.test.mjs` was trimmed to the two value checks
  that carry information (the named imports themselves already fail the file if
  any symbol is missing).
- **Issue #20** — `search`/`serve` reliability: a corrupt `vectors.json` now
  fails with a clear one-line error naming the file and the fix (`error: <path>
  is not valid JSON (<msg>); run \`mdss index\` to rebuild.`) instead of a raw
  `SyntaxError` stack trace. Additionally, loading an index that is **stale**
  (a `.md` under the indexed `--db` was modified after the index was built —
  detectable because the index stores `db` + `built`) prints a non-fatal
  `warning: index is N min older than the newest change in <db>; run \`mdss
  index\` to refresh.` on stderr. Search still runs on the stale snapshot; the
  warning fires on `loadIndex` (CLI `search`, `serve` startup, library use).
- **Issue #22** — `tokenize()` no longer drops short identifiers from the
  lexical lane. The old 3-char minimum (`{3,}`) silently discarded `C#`, `C++`,
  `go`, `io`, `V8`, `d3`, `jq`, `ES7` — exactly the short terms an engineering
  wiki is full of. Now the floor is `{2,}` with the 2-letter function-word noise
  (`of`, `to`, `in`, `on`, `по`, `от`, `из`, …) moved into the expanded STOP
  list, and tokens may contain `#`/`+`/`-` inside (`C#` → `c#`, `C++` → `c++`,
  `win32-api` stays one token). Tokens must still START with a letter/digit, so
  markdown noise (`## heading`, `---` rules) never becomes a token. Decision
  (flat `{2,}` + STOP vs identifier-only heuristic) is recorded in the code
  comment; measured on the KB corpus: `go`/`io`/`C#` now get non-zero lexical
  contribution with no 2-letter function-word regression.
- **Issue #16** — `serve` security: the daemon now binds to **loopback
  (`127.0.0.1`) by default** instead of all interfaces (`0.0.0.0`/`::`), so
  private notes are no longer silently reachable from the LAN. Network exposure
  is opt-in via `--host <ip>` (or `MDSS_HOST`). `POST /search` bodies are capped
  at 64 KB (`413 Payload Too Large` for oversized streams AND for a declared
  oversized `Content-Length`, with the connection drained rather than left
  half-open), and malformed JSON now returns a clear
  `400 {"error": "invalid JSON body: <msg>"}` instead of being swallowed.
- **Issue #24** — `chunkMarkdown` now hard-wraps a single unbroken paragraph
  longer than `maxChunk` (tables, logs, code dumps without blank lines) on word
  boundaries, so no emitted chunk exceeds the embedding context window. Previously
  such paragraphs were kept whole and silently truncated by the tokenizer at
  embed time.
- **Issue #25** — re-indexing a legacy (pre-0.4) `vectors.json` whose chunks have
  no `vec` field now re-embeds those chunks instead of copying them through the
  file-level fast path. Previously the broken state was preserved verbatim and
  every subsequent search crashed with `TypeError: Cannot read properties of
  undefined (reading '0')` in `cosine(qVec, c.vec)`.
- **Issue #27** — the pinned model revision (`--model id@revision`) is now part
  of the model identity stored in the index AND of `chunkHash`, so a `@revision`
  bump triggers a full rebuild exactly as the README promises. Previously both
  places dropped the revision, so stale vectors from the old revision were
  silently served. NOTE: stored `model` is now `id@revision` (default `@main`),
  and chunk hashes include the revision — upgrading to 0.5.0 triggers a one-time
  full re-index, same as the 0.4.0 `chunkHash` change did.
- **Issue #28** — the "legacy chunks with empty vec" test was a tautology (it
  asserted nothing about the repaired index); it now runs an actual `searchIndex`
  against the rebuilt index and asserts real results come back.
- `--ignore` values are now accumulated instead of the last one overwriting
  the whole list.
- A `--db` that exists but is not a directory now errors clearly instead of
  failing later with a confusing message.
- **Issue #36** — one unreadable file (EACCES, EISDIR after a race, a broken
  symlink) no longer aborts the whole `index` run: it is skipped with a
  `warning: skipping <rel> (<err>)` line and counted in the summary as
  `N skipped`. The file stays out of the new index and its hash record, so its
  old chunks drop exactly like a deleted file's — and it is retried (and
  re-warned) on the next run once it becomes readable again.

## [0.3.0] - 2026-08-08

### Added
- `--json` machine-readable output for `search`.
- `--semantic` flag to skip lexical fusion (pure vector ranking).
- `--offline` flag + `MDSS_OFFLINE=1` env var: never download the model,
  require a cached one.
- `mdss models` command listing the built-in model registry.
- Two-level incremental indexing: per-file md5 *and* per-chunk hash, so
  unchanged sections inside a changed file reuse their stored vectors.
- GitHub Actions workflows: `ci.yml` (tests on Node 18/20/22 + syntax lint)
  and `publish.yml` (npm publish on `v*` tags, with provenance).

### Changed
- Default embedding model is `multilingual-e5-base` (768 dims).
- Model weights downloaded in quantized (q8) form when available.
- Raw `Xenova/*` ids and pinned revisions (`id@revision`) accepted; revision
  changes invalidate the index.

### Fixed
- Atomic index writes (temp file + rename) so a crash mid-write cannot corrupt
  `vectors.json`.
- Corrupt-but-present index JSON falls back to rebuild instead of crashing.

## [0.2.0] - 2026-08-05

### Added
- `index` and `search` commands with `--db`, `--index-dir`, `--cache-dir`,
  `--model`, `--ignore`, `--k` options.
- Hybrid ranking via Reciprocal Rank Fusion (cosine + lexical overlap).
- Cross-lingual embeddings with E5 query/passage prefixes.

## [0.1.0] - 2026-08-01

### Added
- Initial release: local semantic search over a folder of Markdown files.

[Unreleased]: https://github.com/chelslava/md-semantic-search/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/chelslava/md-semantic-search/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chelslava/md-semantic-search/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chelslava/md-semantic-search/releases/tag/v0.1.0

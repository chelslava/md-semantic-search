# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

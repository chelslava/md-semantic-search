# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [2.3.1] - 2026-11-14

**Upgrade notes:** none — a packaging-only release to satisfy the official
MCP Registry ownership verification (issue #258). No source changes; indexes
and caches are untouched.

### Added
- **Issue #258** — the npm ownership-verification marker `mcpName`
  (`io.github.chelslava/md-semantic-search`) in `package.json`: the official
  MCP Registry validates that the published npm package carries the marker
  before accepting a `server.json` submission (GitHub-auth namespace rule).
- **Issue #258** — `server.json` migrated to the live **2025-12-11** registry
  schema (camelCase `registryType`, remote items as `{type, url,
  description}`): the previously declared `2025-10-22` schema was silently
  deleted from `static.modelcontextprotocol.io` (HTTP 404) and would have
  failed registry validation. Registry-side semantic validation also
  enforced two manifest changes, caught locally by
  `mcp-publisher validate` before any submission: **description ≤ 100
  chars** and **no `remotes`** — the loopback `mdss serve --mcp` URL is
  rejected as a remote (the registry expects publicly reachable endpoints;
  the HTTP transport stays documented in docs/api-reference.md).
- The `server.json` drift-guard test now also pins `package.json:mcpName ===
  server.json:name` and fetches the declared `$schema` URL, so a schema
  removal upstream fails the suite instead of a release.

### Changed
- CONTRIBUTING: the MCP Registry checklist documents the actual
  `mcp-publisher` flow (`login github` device flow → `publish` → registry
  API verification) instead of an abstract "submit manually".

## [2.3.0] - 2026-11-10

**Upgrade notes:** the legacy embedding/reranker adapters (`e5-small`,
`e5-base`, `e5-large`, `bge-m3`, `bge-reranker-base`) are now pinned to
tested commit SHAs (issue #240) — the revision is part of the model
identity, so indexes built with those adapters **invalidate once**: the
next `mdss index` performs a full re-embed (pin `md-semantic-search@2.2.1`
to defer). The default embedder is unchanged (`granite-multilingual-311m`,
introduced in 2.2.0). Search hits carry `startLine`/`endLine` (issue #249)
and `mdss://vault/{vault}` now answers errors for unknown vaults instead of
silently listing everything (issue #237) — both are additive/strictening
changes to machine-consumed shapes.

### Added
- **Issue #243** — **federated multi-vault search over HTTP**: `mdss serve
  --vault <dir>` (repeatable) plus a `vaults` body field on `/search` and
  `/ask` ("all" or configured vault names only — the client can never name
  an arbitrary path; trust roots pinned per #179). Hits carry vault
  attribution, per-vault failures surface as `vaultErrors` instead of fake
  zero results (#189), `/health` lists the configured vaults, and the web UI
  gains a vault chip row plus a vault badge on every result card. The
  single-vault contract is byte-identical without the flag.
- **Issue #244** — `GET /facets`: tag/type/status/project (+ `custom.<key>`)
  value → count maps computed from the loaded index (no model, no FS walk);
  prefix filtering and field-name validation; surfaced in the web UI as
  count-annotated tag chips and type/status datalist suggestions.
- **Issue #245** — web UI result ergonomics: shareable query URLs (hash-based
  state, back/forward restore), per-result open/copy-link deep links into
  `GET /doc?file=…&fromLine=…`, a results-per-query control (10/20/50/100,
  was hardcoded 20), JSON/CSV export of the current result set, a minimal
  **escape-first markdown renderer** for RAG answers (fenced/inline code,
  wikilinks → /doc deep links, http(s)/same-origin links only — XSS vectors
  pinned by unit tests), and aria-live/listbox accessibility — all within
  the strict-CSP contract (no inline code, no eval).
- **Issue #248** — **query-time MRL truncation**: `--dimensions` /
  `dimensions` in `/search` now sweeps a full-dim index at a reduced
  dimension without a rebuild (truncated renormalized query vector; int8
  sweeps per-D truncated norms cached per generation; ANN probing force-
  disabled since sidecars index full-dim vectors; `explain` reports the
  effective dim). Granite r2 declares vendor-spec'd MRL dims
  [128, 256, 384, 512, 768]. Measured on the 186-query dev slice (real
  granite, offline): nDCG@10 0.8601 at 512 (−0.0052 vs 768), 0.8501 at 256
  (−0.0152), 0.8399 at 128 (−0.0254), Hit@10 ≥ 0.9355 and Recall@10 ≥ 0.9946
  across the board — the vendor's graceful-degradation claim holds; the 768
  anchor reproduces the #227 baseline exactly. Table in RESEARCH §14;
  `scripts/run-bench.mjs --search-dimensions <csv>` runs the sweep.
- **Issue #238** — **extractive abstention** (RESEARCH §18): when no passage
  carries real query support, the extractive answerer now REFUSES ("No
  answer found in the notes", zero citations, closest passages as explicitly
  non-answer context) instead of citing excerpts it cannot ground.
  `extractiveConfidence()` gates on unique-token sentence support with a
  calibrated floor (0.13; `--min-answer-confidence` /
  `MDSS_MIN_ANSWER_CONFIDENCE`, 0 = never abstain) plus a per-sentence
  support floor inside answers. Measured (deterministic profile, ±5pp gate
  re-baselined): spurious-citation rate on unanswerable queries
  **100% → 0%**, citation precision 70.0% → 76.7%; the recall/support drop
  is the fabricated-grounding tail the gate removes. `chatTurn` now scores
  the extractive stage against the context-enriched retrieval query, so
  anaphoric follow-ups ("What percentage?") resolve against carried context
  instead of falling into the excerpts dump. `mode: 'abstained'` propagates
  through sessions, the /ask done frame and the MCP `answerMode`.
- **Issue #250** — launcher parity: Raycast gains an `ask-notes` command
  (streamed POST /ask into a Detail view, launch-argument query) and
  tag/type/status filter preferences; Alfred gains `#tag:eng`-style filter
  keywords and an `ask.mjs` script filter (answer + openable citations,
  abstention-aware). `integrations/README.md` carries the honest client
  capability matrix.
- **Issue #251** — `server.json` manifest for the official MCP Registry
  (npm transport + documented Streamable-HTTP remote), version-synced with
  package.json by a drift-guard test; CONTRIBUTING documents the per-release
  registry checklist.
- **Issue #249** — TUI ergonomics: Enter routes through the shared opener
  (`resolveOpenCommand` — MDSS_EDITOR/VISUAL/$EDITOR, VS Code `--goto`,
  `+line` editors, GUI fallback) with an injectable runner seam; query-term
  highlighting in the preview and RAG panes (SGR reverse video); a `?`/F1
  help overlay; whole-grapheme input (CJK/emoji surrogate pairs were
  dropped) and display-width-aware line clipping. `SearchResultHit` now
  carries `startLine`/`endLine` (RuntimeChunk always had them; the hit shape
  dropped them — `--open` and deep links silently opened line 1).
- **Issue #254** — RESEARCH §13 sweep-kernel profiling gate executed:
  `bench/sweep-profile.mjs` measures warm hybrid latency against the
  isolated dense sweep at 50k (21.1% JS float math) and 100k (41.5%) chunks
  — the pre-registered 40% trigger is breached at 100k, licensing a
  pointwise SIMD sweep prototype as follow-up work (the #228 batching
  kernel does not transfer to a single-vector dot; no production code
  changed). Decision record in RESEARCH §13 and the roadmap gate table.

### Changed
- **Issue #235** — `ann:false` now forces exact brute force: it used to
  behave exactly like `undefined` (auto), leaving no way to disable ANN on a
  large corpus once a sidecar existed. The CLI accepts
  `--ann false|off|none`; bare `--ann` and engine names are unchanged.
- **Issue #236** — a native `fs.watch` handle that dies mid-run
  (inotify ENOSPC/EMFILE, EPERM/EACCES, unexpected close) now degrades to
  interval polling with one loud stderr line; previously `mdss serve --watch`
  silently stopped re-indexing while looking healthy. `FileWatcher.isNative`
  became a live getter. Watcher-death semantics deliberately differ from the
  #116 read-side classification: codes "transient" for reads are fatal to
  the event stream.
- **Issue #240** — immutable revision pinning for the legacy adapters:
  e5-small/e5-base/e5-large/bge-m3 and bge-reranker-base floated on `main`;
  a re-tagged upstream repo silently changed the weights an alias resolves
  to while the adapter fingerprint keyed on the literal string. Every
  registered embedder and reranker now pins a tested commit (unit-tested);
  offline resolution uses the pinned local cache path like the other
  pinned adapters.
- **Issue #247** — fuzzy title/alias scoring runs through a per-array
  vocabulary index (exact-token inverted index + length buckets) with a
  length prefilter instead of a brute scan of every chunk's title tokens;
  `rrf` sorts in place (all callers pass throwaway arrays). Measured on 50k
  chunks: one ~550 ms vocabulary build per generation, warm scans ~50 ms
  (the brute scan paid 200k+ DP calls per query).
- **Issue #242** — the ANN cold path dequantizes once per index generation
  (`getDequantizedVectors`/`getVecList` cached on the runtime state, shared
  with the related-notes path), hoists per-query-variant allocations, and
  drives the in-query HNSW build with the #228 WASM kernel: explicit
  `ann:'hnsw'` first query on a 520-chunk int8 fixture dropped
  **42 s → 1.9 s**. `mdss serve` prewarms the in-memory IVF in the
  background when no sidecar exists and the corpus is ANN-sized.
- **Issue #246** — `findRelatedNotes` caches the per-file grouping,
  LinkDoc list and relationship graph on a WeakMap keyed by the loaded
  index: `/related` and MCP `related_notes` stop rebuilding the graph and
  dequantizing every vector per call (measured ~49× on the second call of a
  40-file fixture; results byte-identical).
- **Issue #239** — CI: npm caching in every job, a windows-latest row in the
  test matrix (win32 is first-class — path rules, longpath, CRLF), coverage
  thresholds documented as the merge gate, `timeout-minutes` everywhere, and
  the failing-test output uploaded as an artifact.
- **Issue #252** — Docker: both stages pinned to the `node:22-alpine`
  digest, OCI `org.opencontainers.*` labels, `src/` dropped from the
  runtime stage (bin imports only ../dist); Dependabot's docker ecosystem
  configured; docs/deploy.md documents the refresh policy.

### Security
- **Issue #241** — `mdss serve` gains explicit per-connection time bounds
  (`headersTimeout` 30 s cuts slowloris-style header dribbles;
  `requestTimeout` 300 s bounds request receive; the /ask SSE stream is
  governed by its per-token idle timeout as before) and
  `--trust-proxy <ip|cidr>`: operator-configured reverse-proxy peers key the
  fairness buckets on the LAST X-Forwarded-For hop, so a team behind one
  nginx no longer shares a single 60/min budget. Default OFF (the header is
  spoofable); `/health` reports the active keying (`client_key`).
- **Issue #234** — `releaseIndexLock` re-verifies lock ownership before
  unlink: a writer that stalled past the staleness window and lost its lock
  to a reclaiming peer no longer deletes the NEW owner's live lock on exit
  (the release-side twin of the #188 re-verify discipline).
- **Issue #252** — the Docker base image (the last unpinned supply-chain
  input) is digest-pinned; runtime surface provenance is preserved by the
  packed-artifact verification job.

### Fixed
- **Issue #237** — four MCP-surface defects: `mdss://vault/{vault}` honored
  its argument (was: any `mdss://vault` prefix returned ALL files);
  `ask_knowledge_base` resolves the session store from the handler's
  `indexDir` (was: a `<db>/.mdss` guess that forked sessions for every
  `--index-dir` deployment); `DELETE /mcp` terminates the session (stale
  POSTs 404, SSE downlink closes); sampling response POSTs resolve BEFORE
  the fairness gates (a rejected reply used to self-deadlock the pending
  `tools/call` until its sampling timeout).
- **tests** — timeout-guard suites made deterministic across node versions
  (a refed keepalive for tests awaiting unref'd guards; node 22.21 drained
  the event loop where 24 held it — cascading `cancelledByParent`), the
  stale-binary-sidecar integrity test made mtime-deterministic (#187
  tie-break), the CLI chat e2e prewarms the L2 query cache (a slow runner
  day used to lose the 30s race against the granite download), and the
  watcher degradation tests stamp explicit future mtimes (mtime-granularity
  flake on loaded runners).
- **eval infrastructure** — `.gitattributes` marks `bench/corpus/**` and
  `bench/fixtures/**` as `-text`: the golden runner fingerprints both, and
  `core.autocrlf=true` on Windows broke both fingerprints (the real-model
  golden set could not run on Windows at all). Blob contents unchanged.

## [2.2.1] - 2026-11-06


### Fixed
- **Issue #227 follow-up** — `mdss models` labeled `e5-base` as "Default":
  the adapter's note text was not updated when the default moved to
  `granite-multilingual-311m` in 2.2.0 (the "(default)" star on granite was
  correct; only the stale e5-base description was). The note now reads
  "Pre-2.2.0 default".

## [2.2.0] - 2026-11-06

**Upgrade notes:** the default embedding model changed from `e5-base` to
`granite-multilingual-311m` (issue #227) — the first `mdss index` after the
upgrade performs a one-time full re-embed (~298 MB model download on first
use); pin `--model e5-base` to keep the pre-2.2.0 behavior and skip the
re-embed. CI now tests the maintained LTS lines (Node 22/24); Node 20 still
runs but prints a deprecation warning (issue #224) and is dropped in v3.0.0.

### Added
- **Issue #231** — OpenSSF Scorecard workflow (`.github/workflows/scorecard.yml`,
  weekly + manual): independent supply-chain maturity signal published to the
  GitHub Security dashboard and code scanning (SARIF). All GitHub Actions
  across all workflows verified SHA-pinned; the scorecard job itself runs with
  least-privilege permissions and `persist-credentials: false`. Manual
  verification + open quick-wins (branch protection, CII badge, SAST) tracked
  in the issue; SECURITY.md documents the program.
- **Issue #229** — RAG answer-faithfulness benchmark (`bench/rag-faithfulness.mjs`): the first measured quality loop for `mdss ask`/`mdss chat` synthesis. 30 answerable queries (golden-set qrels as references) + 8 unanswerable over the frozen corpus; judge-free metrics — citation precision/recall of `citationsUsed`, sentence support rate, spurious-citation rate. Deterministic extractive profile has a committed baseline with a ±5pp drift gate; the LLM profile runs report-only via `MDSS_SMOKE_ENDPOINT`. First slice (RESEARCH.md §18): extractive precision 70.0% / recall 83.3% / support 67.6% — and the documented finding that the extractive fallback cannot refuse (spurious rate 100% by construction).
- **Issue #228** — HNSW full-build acceleration attempt, closed as declined-with-measurements
  (RESEARCH.md §17): profiling shows **84–85% of build time is distance computation** on a
  strictly sequential dependency chain. worker_threads parallelism is structurally blocked
  (a per-hop batch is ~13 µs of work vs ~0.1–0.3 ms roundtrip; concurrent insertion would
  break the byte-identical sidecar contract). A **WASM SIMD128 dot-batch kernel**
  (`src/wasm-dot.ts` — 363 bytes of embedded WAT, zero native dependencies, JS fallback)
  was implemented and measured: **×6.0 on pure 32-dot batches**, **×1.27 end-to-end** on
  equally-warmed interleaved builds (×2.1–2.9 on order-biased pairings) — the beam expands
  1–2 fresh neighbors per hop, so batching rarely amortizes. Recall@10 identical across
  engines; per-engine deterministic sidecars pinned by tests. The kernel ships wired as
  `buildHnsw(..., { engine: 'auto' })` in the indexer; **the §17(a) revisit condition is
  closed as declined — IVF remains the default ANN engine, HNSW stays opt-in.**
- **Issue #226** — Golden set v2: the frozen corpus grew to 26 documents
  (10 new long-form RU/EN notes with frontmatter and 3–4-level heading trees)
  and the query set to **204 graded queries (186 dev / 12 test / 6 holdout;
  100 RU / 104 EN)** — 4× the dev slice that all ranking decisions were
  calibrated on. Two new measured slices with per-category bench reporting:
  `cross-lingual` (query language ≠ answering-document language — the §15
  default-embedder gate) and `long-doc-section` (answers only in 3rd/4th-level
  sections — the §12 late-chunking vs heading-path ablation gate). Hard
  negatives rebuilt from same-topic/cross-topic confuser pairs (grade-0 qrels
  that must not outrank the target). Fixture categories extended in
  `bench/fixture.mjs`; e5-base re-measured on the real model — committed
  baseline **nDCG@10 0.7874 · MRR 0.7577 · Hit@10 0.9301 · Recall@10 1.0**;
  the #198 nightly gate runs against it. Methodology in bench/README.md and
  RESEARCH.md §7.

### Changed
- **Issue #227** — **Default embedding model: `e5-base` → `granite-multilingual-311m`**
  (IBM Granite r2, Apache-2.0, ~298 MB q8, ModernBERT 8k context, CLS pooling).
  Measured on the 186-query golden set v2 against the incumbent: **granite
  nDCG@10 0.8653 vs e5-base 0.7874** (+0.078), MRR 0.8495 vs 0.7577, Hit@10
  0.9624 vs 0.9301, Recall@10 1.0 both. The strictly measured leader
  `embeddinggemma-300m` (0.8691) stays the recommended opt-in, **not** the
  default: the Gemma Terms of Use are not MIT/Apache-compatible and an npm
  default would impose them on every user — with re-evaluation triggers
  documented (an Apache-2.0 EmbeddingGemma successor or a decisive quality
  gap). `qwen3-embedding-0.6b` stays opt-in (Apache-2.0 but 2× the download at
  lower measured quality). **Upgrade note:** the adapter fingerprint change
  invalidates existing indexes — the first `mdss index` after upgrade performs
  a one-time full re-embed (~298 MB model download on first use). Pin
  `--model e5-base` to keep the pre-2.2.0 behavior and skip the re-embed.
  The #198 nightly gate baseline was re-taken with granite (0.8653) and
  verified deterministic; full decision record in RESEARCH.md §15.
- **Issue #224** — Node 20 EOL response: the CI test matrix now covers the
  maintained LTS lines **22 and 24** (was 20+22) and every other workflow runs
  on Node 22. The published `engines` floor stays `>=20.9.0` for now; running
  on a pre-22 runtime prints a one-line deprecation warning to **stderr**
  (`MDSS_NO_NODE_WARNING=1` silences it) while stdout — including `--json`,
  TUI and MCP stdio modes — stays byte-identical. Dropping Node 20 from
  `engines` (a breaking bump, as 18 → 20.9 in v2.0.0) is planned for **v3.0.0**.
  The Docker image was already on `node:22-alpine`; README, docs and
  SECURITY.md document the runtime support table and the v3.0.0 drop plan.
  For security-sensitive deployments (multi-user `mdss serve`) Node 20 is
  explicitly unsupported — it receives no security patches since 2026-04-30.

## [2.1.0] - 2026-11-04

### Added
- **Issue #223** — Watch rebuilds reuse the persisted HNSW graph instead of rebuilding it from scratch: `remapHnsw` re-numbers surviving nodes onto the new chunk indexing via `chunkHash` (vector reuse is hash-keyed, so every carried edge distance stays valid), tombstones removed chunks and inserts only the new ones; a full rebuild happens only on the first run, an engine/budget switch, a corrupt sidecar, or when no top-layer survivor can anchor the entry point. Recall after a remap+insert rebuild is pinned ≥ 0.90 vs brute force by tests; RESEARCH.md §17's revisit condition (b) is closed.
## [2.0.0] - 2026-11-03

**Upgrade notes:** Node ≥ 20.9 is now required. First `mdss index` after the
upgrade re-chunks the corpus under the new token-budget chunker (`chunkBudget`
mismatch forces a full re-chunk; identical chunk texts reuse cached vectors, so
only chunks whose boundaries actually moved re-embed). `mdss search --rerank`
now loads `gte-reranker-modernbert` by default (measured +0.05 nDCG@10 at half
the size, Apache-2.0) — pin `--rerank-model bge-reranker-base` for the
pre-2.0.0 behavior. Retrieval defaults were re-measured against the golden
set; every switch is documented in RESEARCH.md §15–§17.

### Added
- **Issue #201** — HNSW graph ANN alongside IVF: `src/hnsw.ts` is a pure JS/TS Hierarchical Navigable Small World index sharing the IVF contract (build → `hnsw.json` sidecar → candidate pre-filter) with **no training phase**, incremental `insertHnsw`/tombstone `deleteHnsw` (the watch-rebuild path), seeded-deterministic level assignment, and diversity-heuristic pruning (Algorithm 4) — blind top-M pruning stranded whole graph regions (44.4% recall that ignored `ef`); the heuristic restores 100% recall on both bench corpora. `--ann hnsw` switches the engine end-to-end (`hnsw.json` sidecar instead of `ivf.json`, search probe with `--ef` breadth, `check --fix` corrupt-sidecar repair, silent brute-force fallback on a corrupt file); bare `--ann` prefers an existing sidecar. **Measured** (bench/ann-recall.mjs, 1000/5000 vectors): HNSW ≥ IVF on the query side — 100% recall@10 at equal-or-lower p50 latency (0.215 vs 0.252 ms at 5000) — while the build stays ~20× more expensive in JS, so the automatic sidecar keeps **IVF as the default engine**, documented in RESEARCH.md §17 with the revisit conditions (cheaper graph build or persisted-graph watch reuse).
- **Issue #203** — Reranker registry + multi-query expansion. **Registry** (`RERANKERS`, the cross-encoder counterpart of the embedder `MODELS`): `--rerank-model <alias|id@revision>` picks the model without code changes. The issue's proposed `bge-reranker-v2-m3` has no transformers.js artifact (screened out); the measured candidate **`gte-reranker-modernbert`** (Alibaba gte-reranker-modernbert-base, ~144 MB q8, ModernBERT 8k context, Apache-2.0) **passes the non-inferiority gate with proven superiority — nDCG@10 0.9318 vs the incumbent bge-reranker-base's 0.8839 at half the size — and becomes the default reranker** (the incumbent stays registered for reproducibility). **Multi-query**: `--multi-query <n>` embeds N query variants (original + N−1 LLM paraphrases from `--llm-endpoint`, one extra embedding each, shared query cache) and fuses the dense rankings by union-RRF, with ANN probing unioned per variant and `cos` anchored to the original query; without an endpoint or on any LLM failure it is byte-identical to the single-query baseline (graceful degradation, same as HyDE). `/search` accepts `multiQuery`/`rerankModel` (the LLM bridge is always the daemon's own `--llm-endpoint`, never a client-supplied URL). Bench table + mechanism contract in RESEARCH.md §16; `run-bench.mjs` gained `--rerank`/`--rerank-model`/`--multi-query` passthrough.
- **Issue #200** — Modern embedding adapter candidates (2024–2025 generation), each pinned to a tested revision with q8 ONNX artifacts and measured on the golden set: **`granite-multilingual-311m`** (IBM Granite r2 — ModernBERT, 8k context, CLS pooling, Apache-2.0, ~298 MB; nDCG@10 0.8761 vs e5-base 0.8797 — non-inferior) and **`embeddinggemma-300m`** (Google EmbeddingGemma — pre-pooled `sentence_embedding` output, MRL 64–768, ~300 MB; **nDCG@10 0.9002 / Hit@10 1.000 vs 0.8797 / 0.979 — measured superior**, the recommended opt-in `--model embeddinggemma-300m`). Rejected during screening: gte-multilingual (no JS-runtime artifact — remote-code modeling), arctic-embed-m (no ONNX), jina-v3 (task-LoRA not expressible via the pipeline), Qwen3-Embedding-4B (fp32-only, 16 GB). The default stays `e5-base` pending a licensing decision on the Gemma license (not MIT/Apache) and golden-set growth — the measured case for the switch is documented in RESEARCH.md §15. Infrastructure: `pooling: 'cls'` support and the `pooledOutput` adapter flag (pre-pooled ONNX graphs embed through a dedicated AutoModel path instead of the feature-extraction pipeline); both are fingerprint-relevant and unit-tested.
- **Issue #196** — End-to-end latency benchmark (`bench/e2e.mjs`): `loadIndex` cold/warm, query latency P50/P95/P99 across the search profiles (hybrid / semantic / ANN / miss) and RSS on a deterministic generated corpus (seeded Mulberry32, default 120 files × 10 sections ≈ 1200 chunks, offline hash embedder so the metric under test is the JS sweep/fusion/load path; unique queries per profile × round so the embedding cache never short-circuits a measurement). `--json` machine report, `--compare <baseline>` regression gate (default +20% tolerance → exit 1; gated metrics: load times, latency tails, RSS — `buildIndexMs` is informational), `--update-baseline` to refresh the committed machine-relative `bench/fixtures/e2e-latency-baseline.json`, and `GITHUB_STEP_SUMMARY` publishing. Nightly runs report-only by default; the gate activates on matching runner hardware via the `MDSS_E2E_COMPARE=1` repo variable. Gate helpers (`percentile`, `summarizeLatencies`, `compareWithBaseline`, corpus generator) are pure and unit-tested in `test/e2e-bench.test.mjs`; `bench/README.md` documents the suite.
- **Issue #202** — Token-budget chunking tied to the model's context window: the legacy fixed `~1400 chars` budget was calibrated on English (~4 chars/token), so Russian chunks silently carried ~2× more tokens and overflowed the embedder's `maxTokens` (e5: 512), degrading embedding consistency. Chunks are now budgeted in **estimated tokens** — default `min(adapter maxTokens, 512)` — via a script-calibrated estimator (Cyrillic ≈ 1.8 chars/token, Latin ≈ 4, CJK ≈ 1/char, errs slightly high so a budget-checked chunk never overflows the real tokenizer), with structural atomicity preserved (headings/fence/table repeats, #167 line ranges) and a greedy line/word re-split safety net for script-skewed blocks. `--max-chunk-tokens <n>` overrides the budget (`0` restores the legacy char behavior); the effective budget persists as `chunkBudget` on the index, and a budget switch forces a full re-chunk of otherwise-unchanged files (no mixed indexes) while identical chunk texts still reuse cached vectors through `chunkHash`. Golden-set gate before/after: nDCG@10 0.8797 unchanged, Recall@10 1.0000 (EN-dominant fixture corpus stays below the new budget — RU parity is pinned by unit tests).
- **Issue #199** — OpenAI-compatible chat provider with SSE streaming answers across all three output surfaces: `--llm-endpoint` now speaks the `/chat/completions` lingua franca (llama.cpp, LM Studio, vLLM, Ollama `.../v1`), unified with the HyDE wire format — `mdss ask`, `mdss chat` (one-shot + REPL), the TUI RAG panel, and the built-in web UI render the answer token-by-token (time-to-first-token drops from seconds to milliseconds). Includes a `--llm-provider openai|ollama` pin, a one-shot fallback to the Ollama-native `/api/generate` when the endpoint answers 404/405 (existing Ollama-root setups keep working with default flags), a new `POST /ask` SSE endpoint on `mdss serve` (`sources` → `delta` → `done` frames, same fairness gates as `/search`, `400` without `--llm-endpoint`, web UI "✦ Ask the notes" card), and an **idle** fetch timeout (armed on connect, reset per token) so hung backends fail fast without ever killing a long generation mid-answer (issue #184 semantics). Follow-ups in the same effort: `POST /ask` accepts `sessionId`/`chat` for **persistent multi-turn chat over SSE** (the same `<indexDir>/sessions/` store as `mdss chat`, web UI chat toggle with history and a "new chat" reset); `chatTurn` now returns/persists the synthesis `mode` (fixes the CLI chat REPL mislabeling a completed stream as an interrupted fallback); every synthesis result and `done` frame carries **`citationsUsed`** — the citations the answer text actually mentions (`[file#heading]` / `[file › heading]` / `[file]`), derived deterministically without changing the `citations` manifest semantics; `scripts/smoke-chat-backend.mjs` probes a real llama.cpp/LM Studio/vLLM/Ollama backend through the production SSE parser (TTFT + totals, nightly CI step gated by the `MDSS_SMOKE_ENDPOINT` repo variable); the Obsidian plugin gains an **Ask** tab consuming the same stream with a chat toggle (persistent sessions, per-session history, new-chat reset; helpers `buildAskRequest`/`extractSseFrames` unit-tested), and the VS Code sidebar gets the same **Ask** panel through the Extension Host (`askDaemon` streaming via postMessage frames, #165 architecture preserved) — with the shared daemon client (`integrations/shared/search-client.mjs`) gaining a tested streaming `ask()` + `extractSseFrames` + optional `apiKey` Bearer support for every integration.
- **Issue #197** — MCP protocol `2025-11-25`: version negotiation across `2025-11-25`/`2025-06-18`/`2025-03-26`/`2024-11-05` (supported client versions echoed verbatim, unknown ones answered with the server's newest — both transports share one negotiation path), a `ping` responder, and client-side **sampling** for `ask_knowledge_base`: when the client declares the `sampling` capability, synthesis runs on the client's own LLM via a server→client `sampling/createMessage` request (stdio: JSON-RPC lines on the same pipes; Streamable HTTP: the GET `/mcp` SSE downlink with the answer POSTed back) with no local LLM and no user configuration. Any failure — capability absent, client refusal, timeout (`MDSS_SAMPLING_TIMEOUT_MS`, default 60 s) — degrades to the built-in extractive answer, and the tool payload reports the path taken via the new `answerMode` (`sampling`/`extractive`).

### Security
- **Issue #165** — VS Code extension: eliminated a stored-XSS vector in the sidebar webview (note `title`/`heading`/`snippet` were interpolated into `innerHTML` unescaped — now HTML-escaped, with error messages escaped too); sidebar search moved behind the Extension Host via `postMessage` and the shared daemon client, honoring `mdss.daemonUrl` and the new `mdss.apiKey` setting (`Authorization: Bearer`) instead of a hardcoded `http://127.0.0.1:8747/search`.

### Changed
- **Breaking:** minimum Node version raised from 18 to **20.9.0** (`engines`, CI matrix). `@huggingface/transformers` 4.3.x pulls `sharp` 0.35.x, which requires Node ≥20.9 and cannot load on Node 18; Node 18 has been EOL since April 2025. This upgrade also resolves the transitive adm-zip and sharp advisory baseline, so the security audit runs with zero waivers (issue #17).

### Fixed
- **Issue #167** — Structural chunking no longer drifts `startLine`/`endLine` when an oversized code/table block is split: sub-chunk line ranges now track only real source lines (synthetic fence/header repeats excluded), so `--open`, `/doc`, and VS Code jump-to-line land on the right spot.
- **Issue #166** — `planRepairs` (behind `mdss check --fix`) now detects a `vectors.json.sha256` mismatch — the same integrity failure `mdss check` reports — and plans a `rebuild-index` (with the same `--db` gating as corrupt JSON) instead of printing "nothing to repair".
- **Issue #164** — Recency age source priority flipped to `updated` → `created` → file mtime: long-lived notes that were recently revised are no longer penalized by their original creation date.
- **Issue #163** — Recency candidate starvation: with `--recency` the fusion pool now expands to `Math.max(50, k * 5)` (like the `--max-per-doc` path) so fresh documents ranked below `k` by raw RRF can still be rescored and surface; the final `k`-truncation moved after the recency re-sort.
- **Issue #148** — MCP `resources/read` now rejects note paths that resolve outside the indexed note directory, including POSIX traversal and UNC-style absolute paths.
- **Issue #149** — Reject path-traversal session IDs before chat persistence reads or writes the filesystem.

## [1.1.0] - 2026-08-30

### Added
- **Issue #147** — Persistent citation-first chat sessions: interactive REPL `mdss chat [--session <id>] [--resume]`, multi-turn context carry-over, reproducible source manifests with exact line ranges (`citations ⊆ manifest`), and multi-turn agent conversations via `ask_knowledge_base(sessionId)`.
- **Issue #146** — MCP Specification (2025-11-25) upgrade: dynamic resources (`mdss://note/{path}`, `mdss://note/{path}?fromLine=…&maxLines=…`, `mdss://vault/{vault}`, `mdss://status`), 5 workflow prompts (`search-and-cite`, `summarize-note`, `compare-notes`, `find-contradictions`, `timeline`), and `structuredContent` across all tool responses with `readOnly`/`idempotent` annotations.
- **Issue #145** — Obsidian related notes panel: dedicated side-panel tab consuming `/related`, active note tracking with debounced `file-open` event listener, connection failure cards, and relationship badges (`outgoing link`, `backlink`, `bi-directional link`, `2-hop co-citation`, `semantic similarity`).
- **Issue #144** — Interactive TUI filter DSL parity: in-session `Ctrl+F` filter editing with resilient error recovery, header badges for active filter expressions, `--since` cutoffs, and tag constraints.
- **Issue #143** — MRL dimension selection (`--dimensions <n>` / `--dim <n>`): truncated vector storage and dot-product acceleration for Matryoshka models (`qwen3-embedding-0.6b` and `bge-m3`), $L_2$ unit re-normalization, adapter fingerprint invalidation, and `bench/mrl-recall.mjs`.
- **Issue #142** — Config trust policy for repo-checked-in `.mdssrc.json`: strict execution/network boundary rules in `CONTRIBUTING.md` and `SECURITY.md`, machine-auditable `trustTiers` (`local-safe`, `network`, `exec`, `unknown`) in `mdss check --json`.
- **Issue #141** — Related Notes Graph API: `findRelatedNotes` algorithm combining 1-hop, 2-hop co-citations, and centroid semantic cosine similarity, CLI command `mdss related`, HTTP endpoints `POST /related` and `GET /related`, and MCP tool `related_notes`.
- **Issue #140** — Line-range retrieval: `getDocLines` helper in `src/core.ts` with disk-read and chunk-fallback reconstruction, HTTP endpoint `GET /doc`, and MCP tool `get_lines`.
- **Issue #139** — Deterministic k-means++ centroid seeding: Mulberry32 PRNG $D^2$-weighted initial cluster selection to prevent centroid collapse on adjacent correlated notes, empty cluster tracking (`onMetric`), and `bench/ann-recall.mjs` recall quality gate.
- **Issue #137** — Obsidian search view result parity: safe DOM term highlighting (`matches[]`), full arrow key navigation, relevance score bars, connection diagnostics, and daemon startup error cards.
- **Issue #136** — Obsidian plugin test suite: pure helper extraction (`helpers.mjs`, `helpers.d.ts`) and unit tests in `test/obsidian-plugin.test.mjs`.
- **Issue #135** — `ARCHITECTURE.md`: contributor internals guide — module map of all 31 `src/*.ts` files, data-flow diagrams, on-disk format specs, and extension checklists.
- **Issue #133** — Contributor onboarding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue & PR templates.

### Fixed
- **Issue #134** — Cancel stale in-flight `/search` requests: `AbortController` cancellation and monotonic sequence counter guards in Web UI and Obsidian plugin.
- **Issue #138** — Type safety at rerank/IVF boundaries: replaced untyped `any` with strict structural interfaces in `src/rerank.ts`, added finite tensor validation, and hardened `deserializeIVF` against malformed payloads, misaligned centroid buffers, and duplicate/out-of-bound cluster indices.

## [1.0.3] - 2026-08-24

### Added
- **Windows tray companion** (`integrations/windows/`) — zero-dependency
  system-tray icon for `mdss serve`: state-colored icon (healthy / busy /
  unreachable), tooltip with live indexing stats (chunks, model, index age,
  watch), balloon on every knowledge-base rebuild, menu with Web UI / Start /
  Stop / Exit. Attach mode plus `-Launch` owned-daemon mode; `-ApiKey` /
  `MDSS_API_KEY` support; `-CheckHealth` headless self-test (exit 0/1) for
  scripts and CI; single-instance mutex guard.
- **One-command launcher**: `integrations/windows/start-mdss.cmd <notes-dir>`
  — reuses a running daemon or spawns a hidden `mdss serve --watch`, waits for
  the model to warm up, then starts the tray. Setup guide in
  `integrations/windows/README.md` (incl. autostart-at-login recipe).

### Fixed
- **Install documentation drift**: `docs/index.md` quick start used a
  nonexistent `--query` flag and omitted the required `--db`; "zero native
  dependencies" claim corrected (ONNX Runtime ships as prebuilt binaries);
  Node ≥ 18 requirement surfaced in README and docs index; Docker deploy path
  linked from the Install section.
- **Stale `docs/cli-reference.md`** regenerated from the parser — ~56 lines of
  missing flags (`completions`, `--api-key-file`, `--rate-limit`,
  `--max-concurrency`, `--allowed-host`, `--filter`, `--graph-boost`, …).
- **Tray startup crash**: `FormWindowState` has no `Hidden` member — the
  assignment threw and killed the script within a second of launch.

## [1.0.2] - 2026-08-22

### Fixed
- **Silent CLI under Windows npm-link junctions** — the entry-point guard
  `import.meta.url === pathToFileURL(process.argv[1])` never matched when Node
  resolved the entry script through an NTFS junction (i.e. a global `mdss` /
  `md-semantic-search` shim created by `npm link`), so every command exited 0
  with no output instead of running. The guard now compares real paths via
  `fs.realpathSync` with a lexical fallback, which also covers pnpm and other
  symlinked installs; plain (copied-file) installations behave exactly as
  before. Applied to `bin/cli.mjs` and `scripts/run-bench.mjs`.

## [1.0.1] - 2026-08-19

### Fixed
- **Node 18 serve hang** — `server.close()` on Node 18 does not drain keep-alive
  TCP connections, causing the `close()` method of `createServe()` to block
  indefinitely when any client socket remained open after a request. Fixed by
  calling `server.closeAllConnections()` (available since Node 18.2.0) before
  `server.close()`, which forcibly terminates all idle sockets and lets the
  shutdown promise resolve immediately. The affected test now completes in ~36 ms
  instead of hanging for the full GitHub Actions 6-hour timeout.
- **CI test job timeout** — added `timeout-minutes: 10` to the `test` matrix job
  in `.github/workflows/ci.yml` as a second-layer guard against future hangs.

## [1.0.0] - 2026-08-18

### Milestone
- **Production LTS & API Freeze**: Formal declaration of API stability, schema backward compatibility guarantees, security hardening, and scale benchmarking.

### Added
- **Issue #104** — Schema v4 LTS Freeze & Long-Term Backward Compatibility Guarantee.
  - Frozen index schema format with automated cross-version compatibility suite (`test/schema-lts.test.mjs`) ensuring seamless loading across legacy decimal (`v0`), base64 binary chunks (`v1`), legacy overlap lexical (`v2`), and Schema v3/v4 LTS envelopes.
  - TypeScript types and public API frozen under SemVer LTS guarantee.
- **Issue #105** — Large-Scale 1M+ Chunk Benchmark & Competitor Comparison Suite.
  - Synthetic large-scale benchmark harness in `bench/benchmark-1m.mjs` verifying sub-60ms retrieval latencies across 50,000+ chunks and INT8 4x memory savings.
  - Comprehensive architectural comparison published in `docs/benchmarks.md` detailing performance against Qdrant, ChromaDB, and ripgrep.
- **Issue #106** — Production Hardening, Security Fuzzing & Zero-Vulnerability Audit.
  - Security fuzzing test suite in `test/security-fuzzing.test.mjs` validating path traversal guards, UNC network protections, malformed binary index rejection, and AST filter resilience.
  - Concurrency stress test suite in `test/concurrency-stress.test.mjs` testing 50 parallel daemon HTTP search requests without socket leaks or race conditions.

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

[Unreleased]: https://github.com/chelslava/md-semantic-search/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/chelslava/md-semantic-search/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/chelslava/md-semantic-search/compare/v1.1.0...v2.0.0
[0.3.0]: https://github.com/chelslava/md-semantic-search/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chelslava/md-semantic-search/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chelslava/md-semantic-search/releases/tag/v0.1.0

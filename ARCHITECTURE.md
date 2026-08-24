# md-semantic-search — Contributor Internals Guide

This document is the **contributor-facing internals reference**: module map,
data-flow diagrams, on-disk format specification, and extension-point
checklists. It complements the high-level, user-facing
[docs/architecture.md](./docs/architecture.md) and the README's
"Architecture & Retrieval Pipeline" section, and serves the contributor funnel
described in [CONTRIBUTING.md](./CONTRIBUTING.md) (it resolves #135).

Scope: everything under `src/` — strict TypeScript compiled to `dist/`, ESM
only, Node >= 18, single runtime dependency `@huggingface/transformers`.
The CLI entry (`bin/cli.mjs`) parses args and dispatches into these modules.

---

## 1. Module map

Every file in `src/*.ts`, with its responsibility, key exports, and the test
suites under `test/` that cover it (tests import the compiled `dist/*.js`).

| Module | Responsibility | Key exports | Covering tests |
|---|---|---|---|
| `search.ts` | Index loading/validation and hybrid retrieval: dense sweep or ANN candidates, BM25F + fuzzy lanes, RRF fusion, collapse, recency, graph boost, query caches | `loadIndex`, `searchIndex`, `search`, `rrf`, `QueryEmbeddingCache`, `recencyBoost`, `expandExpansionTerms` | `search.test.mjs`, `query-cache.test.mjs`, `recency.test.mjs`, `expand-prf.test.mjs`, `schema-lts.test.mjs` |
| `completions.ts` | Single-source-of-truth shell-completion generator; `FLAGS` table doubles as the drift-guard contract vs `bin/cli.mjs` `parseArgs` | `FLAGS`, `COMMANDS`, `generateCompletion` | `completions.test.mjs` |
| `serve.ts` | HTTP daemon: warm index + model, `/search`, `/health`, auth/Host/CORS/rate-limit/concurrency gates, watch loop, `/mcp` mount | `createServe`, `TokenBucket`, `BoundedSemaphore`, `ServeLimiter`, `validateBindSecurity` | `serve.test.mjs`, `auth.test.mjs`, `concurrency-stress.test.mjs` |
| `providers.ts` | Pluggable external embedding providers (Ollama, OpenAI-compatible) producing an embed fn + synthetic `ModelAdapter` so provider switches invalidate vectors like model switches | `resolveExternalEmbedder` | `providers.test.mjs` |
| `query-cache-disk.ts` | L2 disk-backed LRU (512) of query embeddings at `<cacheDir>/query-cache.json`; sha256 sidecar integrity, silent rebuild on corruption | `diskQueryGet`, `diskQueryPut`, `QUERY_CACHE_FILE` | `query-cache-disk.test.mjs` |
| `open.ts` | Editor jump for hits: pure resolution of `$MDSS_EDITOR`/`$VISUAL`/`$EDITOR` command + injected runner (no real spawns in tests) | `resolveOpenCommand`, `openHit` | `open.test.mjs` |
| `webui.ts` | Built-in web UI shipped as three compiled-in assets (HTML/JS/CSS) enabling a strict CSP with no inline code | `WEBUI_HTML`, `WEBUI_JS`, `WEBUI_CSS` | `webui.test.mjs` (indirect, via `createServe`) |
| `watcher.ts` | OS-native recursive `fs.watch` wrapper: debounce coalescing, FS-error classification, read retry, interval-poll fallback | `createFileWatcher`, `classifyFsError`, `readWithRetry` | `watcher.test.mjs`, `watcher-resilience.test.mjs` |
| `repair.ts` | Plan/apply safe auto-repairs for `check --fix` (stale lock, `.sha256` mismatch, corrupt `ivf.json`); never touches source notes | `planRepairs`, `applyRepairs` | `check-fix.test.mjs` |
| `index.ts` | Public library API surface re-exported as the package root (`main`/`exports` → `dist/index.js`) | `buildIndex`, `search`, `searchIndex`, `MODELS` | `lib.test.mjs` (via the `md-semantic-search` exports map) |
| `download-progress.ts` | Aggregated multi-file model-download progress bar (percent, smoothed MB/s, ETA) with warm-cache silence gate | `DownloadProgressAggregator` | `download-progress.test.mjs` |
| `rerank.ts` | Lazy cross-encoder reranking (`Xenova/bge-reranker-base`), cached per session options | `getReranker`, `rerankScores`, `RERANK_MODEL` | `rerank.test.mjs`, `nightly-real-model.mjs` |
| `core.ts` | Shared kernel: model loading/embedding, markdown walking + legacy chunking, cosine, base64 vectors, path safety/globs, index lock | `embed`, `walkMarkdown`, `assertSafePath`, `acquireIndexLock`, `withIndexLock`, `SCHEMA_VERSION` | `core.test.mjs`, `retry.test.mjs`, `session-options.test.mjs`, `security.test.mjs`, `lock.test.mjs` |
| `mcp.ts` | MCP server brain: tool registry + JSON-RPC 2.0 request handling shared by stdio and HTTP transports | `MCP_TOOLS`, `handleMcpRequest`, `startMcpServer` | `mcp.test.mjs`, `mcp-http.test.mjs` |
| `binary-format.ts` | Zero-copy `vectors.bin` container: 64-byte header + vector section + UTF-8 JSON metadata section, fp32 or int8 payloads | `serializeBinaryIndex`, `deserializeBinaryIndex`, `readBinaryHeader` | `binary-format.test.mjs`, `quantization.test.mjs`, `security-fuzzing.test.mjs` |
| `filter.ts` | Boolean filter DSL over frontmatter tags/properties/dates (AND/OR/NOT, comparisons) | `tokenizeFilter`, `parseFilter`, `evaluateFilter` | `filter.test.mjs`, `security-fuzzing.test.mjs` |
| `summarize.ts` | Deterministic extractive summarization + keyphrase tag extraction (no LLM) | `analyzeNote`, `summarizePassage`, `extractKeyphraseTags` | `summarize.test.mjs` |
| `rag.ts` | Grounded QA synthesis with `[file#heading]` citations; local LLM bridge plus zero-dependency extractive fallback | `askQuestion`, `synthesizeAnswer`, `extractAnswerFallback` | `rag.test.mjs` |
| `tui.ts` | Interactive terminal search UI (readline), opens hits via `open.ts` | `runTui` | `tui.test.mjs` |
| `federation.ts` | Multi-vault/multi-repo search: parallel per-vault loads merged with calibrated RRF + vault attribution | `searchFederated` | `federation.test.mjs` |
| `indexer.ts` | Two-level incremental index build (per-file md5 + per-chunk hash), batched embedding with workers, checkpointing, locked atomic publish | `buildIndex`, `canonicalPassage`, `chunkHash` | `indexer.test.mjs`, `progress.test.mjs`, `integrity.test.mjs`, `workers.test.mjs` |
| `index-format.ts` | `vectors.json` envelope validation: schema version guard, chunk shape, vector decoding, lexical validation | `validateIndexEnvelope`, `validateCurrentChunk`, `inspectIndexSchema` | no covering tests (exercised indirectly via `loadIndex` in `schema-lts.test.mjs`, `integrity.test.mjs`) |
| `quantization.ts` | Int8 scalar quantization tier for normalized float32 vectors (~4x memory, <1% precision loss) | `quantizeToInt8`, `dequantizeFromInt8`, `asymmetricCosineInt8` | `quantization.test.mjs` |
| `markdown-parser.ts` | Structural Markdown parser/chunker: headings, fenced code, tables, blockquotes, lists; token-budget splitting | `parseMarkdownBlocks`, `chunkMarkdownStructural`, `PARSER_VERSION` | `markdown-parser.test.mjs`, `fuzz.test.mjs` |
| `wikilinks.ts` | Obsidian wikilinks + relative Markdown links → resolved relationship graph, related notes, PageRank | `extractLinks`, `resolveLinks`, `buildRelationshipGraph`, `computePageRank` | `wikilinks.test.mjs` |
| `ivf.ts` | IVF clustering for approximate nearest neighbors above the brute-force threshold | `trainIVF`, `searchIVFCandidates`, `serializeIVF`, `ANN_THRESHOLD` | `ann.test.mjs` |
| `models.ts` | Embedding model adapter registry: explicit prefixes/pooling/normalization/dim/dtype per model + adapter fingerprint hashing | `MODELS`, `resolveModel`, `normalizeAdapter`, `embeddingAdapterFingerprint` | `model-profile.test.mjs`, `providers.test.mjs` |
| `metrics.ts` | Dependency-free retrieval evaluation metrics for the golden-set harness (nDCG, MRR, hit/recall@k, redundancy) | `ndcgAtK`, `reciprocalRank`, `queryMetrics`, `aggregateMetrics` | `metrics.test.mjs` |
| `lexical.ts` | Persisted field-weighted BM25F postings (`bm25-v1`/`bm25-v2`), tokenizer, Damerau-Levenshtein fuzzy title/alias matching | `tokenize`, `bm25Scores`, `analyzeLexicalDocument`, `fuzzyTitleAliasScores` | `lexical.test.mjs`, `bm25f.test.mjs`, `fuzz.test.mjs` |
| `frontmatter.ts` | Typed YAML frontmatter parser/normalizer (title, aliases, tags, project, type, status, canonical identity, dates) — no executable tags | `parseFrontmatter`, `DocumentMetadata` | `frontmatter.test.mjs` |
| `collapse.ts` | Result diversity: dedup/cap chunks per document or canonical identity | `collapseResults` | `collapse.test.mjs` |

---

## 2. Data-flow diagrams

### (a) Index build pipeline (`src/indexer.ts`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ walkMarkdown(db, ignore)                                    core.ts      │
│   recursive .md/.markdown scan, dotfiles + globs skipped                 │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ parseFile → chunkMarkdownStructural                markdown-parser.ts    │
│   AST blocks (headings/code/tables/lists) + active heading stack         │
│   splitFrontmatter/parseFrontmatter                frontmatter.ts        │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ canonicalPassage + chunkHash                       indexer.ts            │
│   passage = title > heading path [#tags] > body                          │
│   chunkHash = SHA-256(passage input + model identity)                    │
│   unchanged hash ⇒ reuse stored vector (per-chunk incrementalism)        │
└───────────────┬──────────────────────────────────────┬───────────────────┘
                ▼                                      ▼
┌───────────────────────────────────────┐ ┌─────────────────────────────────┐
│ embed() batches × --workers  core.ts  │ │ analyzeLexicalDocument          │
│ adapter prefixes/pooling models.ts    │ │ + buildLexicalIndex   lexical.ts│
│ every 8 completed batches:            │ │ (model-independent, reused      │
│   atomicWrite(.checkpoint.json)       │ │  across vector invalidations)   │
└───────────────────┬───────────────────┘ └────────────────┬────────────────┘
                    └──────────────────┬───────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ withIndexLock(indexDir) {                            core.ts .mdss.lock  │
│   validateIndexEnvelope(generated)               index-format.ts         │
│   atomicWrite vectors.json  + vectors.json.sha256   (tmp + rename)       │
│   atomicWrite .hashes.json                                               │
│   serializeBinaryIndex → vectors.bin + .sha256     binary-format.ts      │
│   chunks ≥ ANN_THRESHOLD(500) or --ann ⇒ ivf.json  ivf.ts                │
│   fs.unlinkSync(.checkpoint.json)                ← publish complete      │
│ }                                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

### (b) Search query path (`src/search.ts`)

```
 query text
     │  tokenize                                          lexical.ts
     ▼
 query embedding
     memory QueryEmbeddingCache → miss → diskQueryGet     query-cache-disk.ts
     (<cacheDir>/query-cache.json, key model@rev|dim|sha256(query))
     miss → embed() with the adapter's query formatter    core.ts/models.ts
     → diskQueryPut
     ▼
 candidates
     brute-force cosine sweep  ──or──  IVF probe          ivf.ts
     (auto IVF when chunks ≥ ANN_THRESHOLD = 500 or --ann, nprobe default 8)
     ▼
 scoring lanes
     dense cosine · bm25Scores (persisted bm25-v2 postings) ·
     fuzzyTitleAliasScores (bounded Damerau-Levenshtein on titles/aliases)
     ▼
 rrf(lanes, k=60, weights)                                search.ts
     optional extra lane: expandGraphNeighborhood + computePageRank
     weighted by --graph-boost                            wikilinks.ts
     ▼
 collapseResults(--max-per-file / canonicalRef identity)  collapse.ts
     ▼
 optional: rerankScores cross-encoder on the wider pool   rerank.ts
           (--rerank, pool max(20, k*3))
           recencyBoost 0.5^(age/halfLife) (--recency)     search.ts
     ▼
 top-k hits (each hit carries matches/explain metadata)
```

Legacy schema-v0/v1/v2 indexes keep working through the exact-token-overlap
lane (`keywordScores`); schema-v3 always uses persisted BM25F.

### (c) `serve --watch` loop (`src/serve.ts`, `src/watcher.ts`)

```
 poll every WATCH_INTERVAL_MS = 3000 ms        ← native fs.watch events wake
     │                                           the settle timer early
     ▼
 content-confirm each candidate:
     md5(file bytes) vs the authoritative per-file hashes in .hashes.json
     (mtime only narrows the candidate set — touch/chmod/no-op writes never
      trigger a rebuild; md5 results memoized in an mtime-keyed cache)
     ▼
 settle debounce: quiet period of --watch-delay (default 1000 ms)
     collapses editor-save/linter/save bursts into ONE rebuild
     ▼
 withIndexLock → incremental buildIndex cycle
     (a concurrent `mdss index` holding .mdss.lock makes the cycle defer)
     ▼
 re-seed the md5 cache from the post-build .hashes.json state
```

FS errors during watching are classified (`transient` / `vanished` /
`permanent`) and retried with backoff (`classifyFsError`, `readWithRetry`);
if native events are unavailable the watcher degrades to interval polling.

### (d) MCP transports (`src/mcp.ts`, `src/serve.ts`)

```
 ┌────────────────────────────────────┐   ┌───────────────────────────────────┐
 │ stdio (default): `mdss mcp`        │   │ Streamable HTTP (issue #123):     │
 │ startMcpServer(): JSON-RPC 2.0     │   │ `mdss serve --mcp` mounts /mcp    │
 │ over stdin/stdout via readline     │   │ POST JSON-RPC + GET SSE channel,  │
 │                                    │   │ Mcp-Session-Id, protocol          │
 │                                    │   │ 2025-03-26                        │
 └─────────────────┬──────────────────┘   └─────────────────┬─────────────────┘
                   │                                        │
                   │   both sit behind the serve request    │
                   │   gates: Host allowlist (403) → CORS   │
                   │   → Bearer auth when --api-key (401)   │
                   │   → rate limit / bounded concurrency   │
                   ▼                                        ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ shared tool brain: MCP_TOOLS registry + handleMcpRequest()               │
 │   search_markdown · get_chunk · list_files · index_status ·              │
 │   ask_knowledge_base                                                     │
 │   (implemented over loadIndex/searchIndex/searchFederated/askQuestion)   │
 └──────────────────────────────────────────────────────────────────────────┘
```

Adding a tool means one registry entry + one handler case; both transports
pick it up unchanged.

---

## 3. On-disk format spec

Everything lives in the index directory (default `<db>/.mdss`, override with
`--index-dir`). Facts below come from `src/indexer.ts`, `src/core.ts`,
`src/binary-format.ts`, `src/index-format.ts`.

### `vectors.json` — the canonical index envelope

Top level (`PersistedIndex`):

| Field | Meaning |
|---|---|
| `schemaVersion` | `3` today (`SCHEMA_VERSION` in `core.ts`, LTS). Reading a **newer** schema fails with an explicit "upgrade md-semantic-search" error instead of misparsing |
| `format` | `"binary-v1"` — required for v3; anything else is rejected |
| `model` / `modelAlias` | embedding model identity `id@revision` (revision defaults to `main`) + the user-facing alias |
| `adapterFingerprint` | `adapter-v1:<sha256>` over query/passage prefixes, pooling, normalization, native dim (`models.ts`) |
| `dim` | explicit dimension for custom adapters (required when non-empty and resolvable dim is missing) |
| `db`, `built` | indexed folder + ISO build timestamp |
| `chunkCount` | must equal `chunks.length` (validated) |
| `chunks[]` | `{file, title, heading, headingPath[], text, chunkHash, vec(base64 float32), …}` — `headingPath` leaf must equal `heading` |
| `lexical` | `{format: 'bm25-v2'|'bm25-v1', documentLengths, postings}` — validated structurally on every load |

**Adapter-fingerprint semantics** (what invalidates what):

- A change to any fingerprinted semantic — `queryPrefix`, `passagePrefix`,
  `pooling`, `normalize`, or native dimension — or to the model identity
  (`id@revision`) changes the fingerprint. Vectors and `.checkpoint.json`
  become incompatible → full re-embed on the next `index`.
- Lexical records do **not** depend on the adapter: an adapter-only change
  keeps `sourceSchema >= 2 && !modelChanged && adapterCompatible(old)` false
  for *vectors* while lexical documents (whose identity is the passage text +
  headings, not the model) still qualify for reuse.
- Old indexes written before fingerprints existed remain readable: the loader
  accepts them when their shape matches `legacyEmbeddingAdapterFingerprint`
  (E5-style defaults, or no-prefix for bge-family ids).
- Legacy `bm25-v1` lexical stays searchable and upgrades to `bm25-v2` on the
  next build; schema v0–v2 indexes are served through the legacy overlap lane.

### `vectors.bin` + `vectors.bin.sha256` — binary vector store

64-byte little-endian header followed by two sections (`src/binary-format.ts`):

```
0..7    magic 'MDSSBIN1'          24..31 vectorsOffset  (uint64)
8..11   version = 1               32..39 vectorsBytes   (uint64)
12..15  flags (0=FP32, 1=INT8)    40..47 metadataOffset (uint64)
16..19  dim                       48..55 metadataBytes  (uint64)
20..23  chunkCount                56..63 reserved (zeros)
vectors section : chunkCount × dim × (4 bytes fp32 | 1 byte int8)
metadata section: UTF-8 JSON (chunk metadata + lexical state)
```

- Every publish writes the payload atomically (tmp file + rename, pid-suffixed
  tmp name) and refreshes a `<file>.sha256` sidecar containing
  `<digest>  <basename>`. This applies to **both** `vectors.bin` and
  `vectors.json`.
- On load, a SHA mismatch is a hard error ("run `mdss index`"); a missing or
  corrupt `vectors.bin` falls back to parsing `vectors.json` instead.
- INT8 payloads store the quantized tier from `quantization.ts`; queries stay
  fp32 and score via asymmetric cosine.

### `ivf.json` — optional ANN sidecar

Serialized IVF index `{dim, k, centroids(base64 float32), clusters[][]}`,
written only when `--ann` is passed or `chunks.length >= ANN_THRESHOLD`
(500); otherwise a stale file is deleted. A corrupt `ivf.json` never fails a
search — the loader silently ignores it (brute-force fallback) and
`check --fix` offers to remove it.

### `.checkpoint.json` — crash-resume sidecar

- During long builds, a full index snapshot (including `hashes` and a
  `complete` flag) is atomically rewritten every **8 completed embedding
  batches** (`CHECKPOINT_BATCHES = 8`, ≈256 chunks at the default batch size).
- On resume, the checkpoint is validated with the same envelope validator as
  the canonical index and is only reused when schema, format, model identity,
  adapter fingerprint, db path, and lexical structure all match.
- The canonical `vectors.json` + `.hashes.json` always remain the last fully
  published generation; the checkpoint is **deleted** immediately after a
  successful publish.

### `.mdss.lock` — writer ownership

- Content: `{"pid": <pid>, "since": "<ISO timestamp>"}`; created exclusively
  (`wx` flag) by `acquireIndexLock` (`core.ts`), released in a `finally` by
  `withIndexLock`.
- A second writer receives a clear error naming the owning pid and start time
  (`index is being written by pid NNN (since …)`); `serve --watch` defers its
  cycle instead of failing.
- Self-heal rules: the lock is reclaimed (unlinked, then retried once) when it
  is unreadable garbage, when the recorded pid is dead (`pidAlive`), or when
  the file's mtime is older than 10 minutes (`LOCK_STALE_MS`) — a crashed
  writer can never wedge the index. `check --fix` also removes a stale lock.

---

## 4. Extension-point checklists

### (a) Adding an embedding model adapter (`src/models.ts`)

1. Add an entry to the `MODELS` registry with the full explicit adapter
   contract: `id` (+ `revision` to pin), `nativeDim`/`dim` (+ optional MRL
   `dimensions`), `queryPrefix`/`passagePrefix`, `pooling`
   (`mean`/`last_token`/`none`), `normalize`, `dtype` (default `q8`),
   `maxTokens`, `family`. `normalizeAdapter` fills/validates the shape.
2. Understand the fingerprint implications: `embeddingAdapterFingerprint`
   hashes prefixes + pooling + normalize + native dim. A new adapter is
   automatically a distinct index identity; editing any of those fields on an
   existing adapter silently invalidates users' vectors and checkpoints
   (full re-embed) — treat such edits as breaking and say so in the
   changelog. Lexical records survive either change.
3. Never let a raw Hugging Face id inherit defaults: unregistered ids must
   keep failing at embed time with a pointer to the README "How to add a
   model" section.
4. Tests: extend `test/model-profile.test.mjs` (adapter fields, fingerprint
   stability across identical inputs, difference across changed semantics);
   cover indexing round-trips in `test/indexer.test.mjs` style if the adapter
   changes passage construction.
5. Docs: add the alias to the README Models table and the `--model` help
   surface; `mdss models`, `stats`, and `check` render straight from the
   registry.

### (b) Adding an export format (`bin/cli.mjs` `cmdExport`)

1. Add a dispatch branch in `cmdExport` (`bin/cli.mjs`), following the
   Parquet pattern: optional dependency loaded lazily via dynamic `import`,
   with a clear `die()` message when it is missing, and a required `--output`
   target for non-streamable formats.
2. Update the `unknown export format` error list and the usage text in the
   same file.
3. Update the README: the `--format` row in the Options table and the
   "Export the index" section (output schema example for the new format).
4. Extend `test/export.test.mjs` (round-trip, `--no-vectors`, error paths).
5. CLI-surface rule (applies to every change here): if you add/rename a flag
   or subcommand, update the `FLAGS`/`COMMANDS` tables in
   `src/completions.ts` and the README Options table in the same PR —
   `test/completions.test.mjs` diffs `FLAGS` against `bin/cli.mjs`
   `parseArgs` and will fail on drift in either direction.

### (c) Adding an external embedding provider (`src/providers.ts`)

1. Add a branch to `resolveExternalEmbedder`: accept a `ProviderConfig`
   (`embedder`, `model`, optional `baseUrl`/`keyFile`, injected `fetchImpl`
   for tests) and return a `ResolvedEmbedder` with (a) an `embedFn` matching
   the local `core.embed` signature `(texts, role, model, cacheDir, offline)`
   and (b) a `descriptor()` producing a synthetic `ModelAdapter` (probe the
   endpoint once for the true dim).
2. Do not special-case anything downstream: the synthetic descriptor flows
   through the existing adapter-fingerprint, dim-validation, and index
   metadata machinery, so pointing `--embedder` at a different provider or
   model invalidates vectors exactly like a local model switch. The provider
   id/model/dim are recorded in the index envelope.
3. Key handling follows `loadApiKeyFile` (`--embedder-key-file`); never log
   keys or full payloads.
4. Local transformers.js remains the zero-config default and the only fully
   offline path — keep the provider strictly opt-in behind explicit flags.
5. Tests: `test/providers.test.mjs` with injected `fetchImpl` (happy path,
   HTTP error mapping, fingerprint of the synthetic descriptor).
6. New flags (if any) → `src/completions.ts` + README Options table
   (drift-guard applies).

### (d) Adding an MCP tool (`src/mcp.ts`)

1. Append a descriptor to the `MCP_TOOLS` array: `name`, `description`,
   JSON-Schema `inputSchema` (`required` included).
2. Handle it in `handleMcpRequest`'s `tools/call` dispatch, building on
   `loadIndex`/`searchIndex`/`searchFederated`/`askQuestion` rather than
   touching transport code — stdio (`startMcpServer`) and Streamable HTTP
   (`serve --mcp` → `/mcp`) both get the tool for free, including all
   auth/host/rate-limit gating.
3. Tests: extend `test/mcp.test.mjs` (registry introspection +
   `handleMcpRequest` behavior); exercise the HTTP mounting in
   `test/mcp-http.test.mjs` if the tool interacts with serve state.
4. Docs: update the "Available MCP Tools" list in the README.
5. Any accompanying CLI flag → `src/completions.ts` + README Options table
   (same drift guard as above).

---

Verification aids for reviewers: the module-map row count equals
`ls src/*.ts | wc -l` (31); every test filename referenced above exists under
`test/`; linked files (`docs/architecture.md`, `CONTRIBUTING.md`,
`README.md`) exist at the repo root or `docs/`.

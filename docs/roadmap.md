# Product Roadmap

`md-semantic-search` is a local-first, Markdown-native hybrid retrieval engine: dense multilingual embeddings + field-aware BM25F + fuzzy lookup fused by RRF, optional cross-encoder reranking, an ANN layer (IVF / HNSW), and a citation-first RAG surface — all offline, zero infra, one JSON index. Every retrieval default is backed by a measurement in [RESEARCH.md](https://github.com/chelslava/md-semantic-search/blob/main/RESEARCH.md).

The plan below follows the project's operating principle: **no speculative features** — work either maintains the platform, grows the measurement base, or closes an explicitly defined decision gate. The active backlog is the **v2.3.x phase** below ([#258](https://github.com/chelslava/md-semantic-search/issues/258)–[#263](https://github.com/chelslava/md-semantic-search/issues/263)).

---

## Where we are — v2.3.0 (2026-11-10)

| Capability | State | Measured in |
|---|---|---|
| Hybrid retrieval (dense + BM25F + fuzzy → RRF), `granite-multilingual-311m` default | shipped | RESEARCH §5, §7, §15 |
| ANN — IVF (default) + HNSW (opt-in, watch-remap) + WASM SIMD dot-batch kernel | shipped | §13, §17 |
| Reranker registry, `gte-reranker-modernbert` default | shipped | §16 |
| Multi-query expansion, HyDE, PRF, recency, graph boost | shipped | §5, §16 |
| Token-budget chunking (RU parity) | shipped | #202 |
| Query-time MRL truncation (768/512/256/128, no re-index) | shipped | §14, #248 |
| Extractive abstention (spurious citations 100% → 0%) | shipped | §18, #238 |
| Federated multi-vault HTTP (`/search`+`/ask` `vaults`, `/facets`, `trust-proxy`) | shipped | #243, #244, #241 |
| MCP 2025-11-25 — negotiation, ping, client sampling, `server.json` manifest | shipped | #197, #251 |
| RAG — `ask`/`chat`, OpenAI-compatible SSE, citations, sessions | shipped | #147, #199 |
| Surfaces — CLI, TUI, daemon HTTP, web UI, Obsidian, VS Code, Raycast, Alfred, Windows tray, Docker | shipped | #126, #135, #165, #250 |
| Golden-set regression gate + e2e latency gate + RAG faithfulness bench (nightly) | shipped | #196, #198, #229 |

## Open decision gates

These are the only places where the retrieval stack may change; each has a measurable trigger defined in RESEARCH.md.

| Gate | Question | Trigger / blocker | Tracked by |
|---|---|---|---|
| RESEARCH §15 | ~~Should `embeddinggemma-300m` replace `e5-base` as the default embedder?~~ **Resolved (#227):** default → `granite-multilingual-311m` (Apache-2.0); gemma opt-in under license veto. Re-evaluation triggers documented (Apache-2.0 EmbeddingGemma successor, or a decisive quality gap). | — | closed |
| RESEARCH §17 | ~~Should HNSW become the default ANN engine?~~ **Declined (#228):** build acceleration measured at ×1.27 end-to-end (kernel ×6 on batches) — the order-of-magnitude trigger is unreachable; IVF stays default. | — | closed |
| RESEARCH §12 | ~~Late chunking vs heading-path context?~~ **Declined (#260):** the `bench/late-chunking.mjs` prototype loses on golden v2 dev (nDCG −0.0441) and loses most of all on the `long-doc-section` slice that motivated the question (−0.1394) — heading-path contextualization stays; late chunking is a documented non-goal for CLS-pooled adapters. | — | closed |
| RESEARCH §13 | ~~WASM SIMD dot-product kernels (sweep side)?~~ **Landed (#259):** the measured SIMD sweep kernel beats the ×2 premise (×3.5–3.7 isolated, −23.5%/−15.2% warm-hybrid p50 at 50k/100k interleaved) and reproduces the golden baseline byte-exactly (nDCG@10 0.8653 → 0.8653) — default dense-sweep path; the js-flat plumbing-only candidate measured and rejected. | — | closed |
| RESEARCH §19 | ~~Low-priority indexing (a `--polite` build mode)?~~ **Declined (#264):** the pre-registered gate failed on cost — below-normal priority halves foreground scheduling gaps (p95 7.3 → 4.1 ms) but costs +30% build wall-time under the measured busy-desktop load; p50 improvement (−17.4%) misses the ≥25% bar. No product code shipped; the opt-in recipe is OS-level (`start /low` / `nice -n 10`), documented in README. | — | closed |
| RESEARCH §20 | ~~Can the full-build peak memory be bounded without changing the persisted format?~~ **Shipped (#265):** batch-streamed persistence (envelope, checkpoints, `vectors.bin` written per chunk; fp32 released as encoded). The OS-tracked peak at 100k/dim768 dropped 2,366.9 → 1,221.8 MB (fp32) and 2,046.8 → 1,050.4 MB (int8) — the step-1 sampled table had understated the old peak ~2.9× (a same-thread timer sampler cannot see sync-phase spikes; `resourceUsage().maxRSS` is the primary metric now). Persisted bytes pinned identical (golden fixture + gate 0.8653 → 0.8653). The remaining ~9 KB/chunk is corpus-side and irreducible under byte-exactness (IVF k-means needs the fp32 corpus). | — | closed |
| RESEARCH §21 | ~~Which ONNX execution backend and thread defaults should embedding use?~~ **Closed declined (measured, #271):** transformers.js v4 in Node already runs the native onnxruntime-node CPU backend (fastest zero-dependency configuration); **DirectML declined 4–5×** on integrated graphics; the #194 intra-op clamp probe advantage (~13%) did not survive the real pipeline — unset arms ×1.046/×1.033 vs the ×1.08 bar, in-run spread comparable to the effect. The clamp stays; harness retained. | [#271](https://github.com/chelslava/md-semantic-search/issues/271) | closed |
| RESEARCH §22 | ~~Can the IVF k-means assignment pass take the §13 SIMD sweep kernel?~~ **Shipped (#268):** per-centroid whole-corpus sweeps through the kernel — `trainIVF` 642.4 → **105.9 s** (×6.1) on the 100k worst case, §20 fixture 100k build 250.6 → **103.3 s** (×2.43); the drift probe produced a **byte-identical sidecar digest** with recall@10 unchanged; golden gate byte-exact; maxRSS +88 MB (+7.2%). The JS path stays as the fallback and a forced engine (`engine: 'js'`). | [#268](https://github.com/chelslava/md-semantic-search/issues/268) | closed |
| RESEARCH §23 | Should a 3×-smaller same-family fast profile exist? `granite-embedding-97m-multilingual-r2-ONNX` (Apache-2.0, dim 384, CLS) as an **opt-in** alias — ship iff golden drop ≤ 0.03 vs granite-311m AND wall ≥ ×1.3; the default is not touched (§15 contract). | [#269](https://github.com/chelslava/md-semantic-search/issues/269) | open |
| RESEARCH §24 | What does the static-embedding fast tier cost in quality? model2vec/potion class (~100–150× cheaper, pure-JS lookup+mean-pool) as an opt-in profile — ship iff golden hybrid drop ≤ 0.05 AND wall ≥ ×20 at 50k; else the survey becomes the documented quality/speed frontier. | [#270](https://github.com/chelslava/md-semantic-search/issues/270) | open |

---

## v2.2.0 — Platform Modernization & Decision Gates (target: December 2026)

- [x] **Node 20 EOL response** (#224): CI matrix on maintained LTS lines 22/24; runtime deprecation warning for pre-22; `engines` floor stays `>=20.9` until v3.0.0.
- [x] **Roadmap current** (#225): this document; obsolete v0.x milestones closed.
- [x] **Golden set 48 → 186 dev** (#226): balanced RU/EN, explicit cross-lingual and long-doc slices, hard negatives from confuser pairs; #198 gate re-baselined.
- [x] **Default embedder decision** (#227): `granite-multilingual-311m` (Apache-2.0) is the new default — nDCG@10 0.8653 vs e5-base 0.7874 on golden v2; `embeddinggemma-300m` stays opt-in under the Gemma license veto (re-evaluation triggers in RESEARCH.md §15).
- [x] **HNSW full-build acceleration** (#228): worker parallelism declined as structurally blocked; WASM SIMD dot-batch kernel shipped (×6 on pure batches, ×1.27 end-to-end, recall identical) — §17(a) revisit closed as declined-with-measurements; IVF stays the default engine.
- [x] **RAG answer quality bench** (#229): citation precision/recall, coverage, refusal correctness for `ask`/`chat` — the first measured quality loop for synthesis, report-only nightly.
- [x] **Integrations hygiene** (#230): alfred/raycast READMEs + tests, dedicated vscode tests, workspace artifact cleanup.
- [x] **OpenSSF Scorecard** (#231): scorecard workflow publishing to the Security dashboard; all actions SHA-pinned (verified across 8 workflows).

## v2.3.x — Release completion & licensed follow-ups (November 2026)

The 2.3.0 code cycle closed with zero open issues; this phase is release-ops
completion plus the follow-ups licensed by the measured gates, plus one
market-driven packaging item.

- [ ] **Release ops** (#258): restore the npm publication of 2.3.0 (the
  `NPM_TOKEN` secret is unauthorized/expired — npm answers 401 with 404 on
  PUT), then submit `server.json`@2.3.0 to the official MCP Registry per the
  CONTRIBUTING checklist. The MCP Registry is the primary discovery channel
  for retrieval servers in 2026; the publish workflow is rerun-safe.
- [x] **§13 sweep-kernel prototype** (#259): the #254 profile breached the 40%
  trigger at 100k chunks (41.5%; 21.1% at 50k). The WAT SIMD128 sweep kernel
  (`src/sweep-kernel.ts`) measured ×3.5–3.7 on the isolated sweep and
  −23.5%/−15.2% warm-hybrid p50 (50k/100k, interleaved equally-warmed), with
  the golden gate reproducing the baseline exactly (0.8653 → 0.8653) —
  the acceptance rule's land branch fired; wasm is the default dense-sweep
  path with silent JS fallbacks (js-flat measured and rejected: no win).
- [ ] **§12 ablation decision** (#260): read the `long-doc-section` slice
  (#226) as heading-path baseline vs late-chunking prototype; either a
  design proposal (measured context-recall gap) or a documented non-goal
  with numbers.
- [ ] **§18 LLM faithfulness profile** (#261): run the RAG faithfulness bench
  against a real OpenAI-compatible backend (`MDSS_SMOKE_ENDPOINT`) — the
  extractive baseline is committed; the LLM path (citation precision/recall,
  support, abstention interplay) has never been measured. Citation
  faithfulness is the primary trust barrier for RAG surfaces.
- [ ] **Agent-skill pack** (#262): a tested SKILL.md recipe + client
  onboarding docs (MCP registration snippets, `mdss://` URIs, ask/related
  patterns) — market finding: agent-facing distribution (the QMD/Claude Code
  pattern) drives adoption in this segment more than raw search quality.
- [ ] **v3.0.0 floor** (#263): the breaking-platform-floor anchor
  (`engines` → Node ≥ 22) — see the outlook below.

## v3.0.0 — Breaking platform floor (outlook)

- [ ] `engines` floor → **Node ≥ 22** (breaking; the 18 → 20.9 precedent in v2.0.0). Announced via the #224 deprecation warning well in advance. Tracked by [#263](https://github.com/chelslava/md-semantic-search/issues/263).
- [ ] Absorb whatever the §12/§13 gates decide — a default-embedder or default-engine switch ships here if the migration UX requires a major.

## Deferred by triggers (not scheduled)

- **Late chunking** — prototype only if the #226 ablation slice shows a measured context-recall deficit of heading-path contextualization (§12).
- **Learned sparse (SPLADE-family)** — BM25F is sufficient at the current corpus scale; revisit if target corpora grow an order of magnitude.
- **WASM SIMD sweep kernels** — closed by #259: the pointwise SIMD sweep kernel landed as the default (−23.5%/−15.2% warm-hybrid p50 at 50k/100k, golden gate byte-exact); the #228 batching kernel observation stays true — batching amortizes only with multiple queries in flight, and the win came from one-crossing-per-sweep SIMD, not from batching.
- **Vector databases / distributed indexes** — out of the project segment (10k–50k chunks, zero-infra), unchanged.

---

*History: the v0.5 → v1.0.0 plan that led here is preserved in [git history](https://github.com/chelslava/md-semantic-search/commits/main/docs/roadmap.md); its milestones (graph retrieval, zero-copy storage, IDE integrations, local RAG, LTS freeze) all shipped between v1.0.0 and v2.1.0.*

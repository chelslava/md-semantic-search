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
| RESEARCH §13 | WASM SIMD dot-product kernels (sweep side)? **Profiled (#254):** the 40% trigger is breached at 100k chunks (41.5%) but not at 50k (21.1%) — prototype conditions met at the larger scale. | prototype with acceptance rule (expected payoff bounded ~21% at ×2) | #259 |

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
- [ ] **§13 sweep-kernel prototype** (#259): the #254 profile breached the 40%
  trigger at 100k chunks (41.5%; 21.1% at 50k) — build the pointwise SIMD
  sweep prototype with an explicit acceptance rule (land only if the measured
  end-to-end win justifies it; expected payoff bounded ~21% at a ×2 kernel);
  otherwise close declined-with-measurements.
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
- **WASM SIMD sweep kernels** — the §13 profile (#254) breached the 40% trigger at 100k chunks (41.5%; 21.1% at 50k): prototype conditions met, but the payoff is bounded (~21% total at a ×2 kernel) and the #228 batching kernel does not transfer to a pointwise sweep. Prototype now tracked as #259 with an explicit acceptance rule.
- **Vector databases / distributed indexes** — out of the project segment (10k–50k chunks, zero-infra), unchanged.

---

*History: the v0.5 → v1.0.0 plan that led here is preserved in [git history](https://github.com/chelslava/md-semantic-search/commits/main/docs/roadmap.md); its milestones (graph retrieval, zero-copy storage, IDE integrations, local RAG, LTS freeze) all shipped between v1.0.0 and v2.1.0.*

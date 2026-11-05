# Product Roadmap

`md-semantic-search` is a local-first, Markdown-native hybrid retrieval engine: dense multilingual embeddings + field-aware BM25F + fuzzy lookup fused by RRF, optional cross-encoder reranking, an ANN layer (IVF / HNSW), and a citation-first RAG surface — all offline, zero infra, one JSON index. Every retrieval default is backed by a measurement in [RESEARCH.md](https://github.com/chelslava/md-semantic-search/blob/main/RESEARCH.md).

The plan below follows the project's operating principle: **no speculative features** — work either maintains the platform, grows the measurement base, or closes an explicitly defined decision gate. The active execution backlog lives in the [v2.2.0 milestone](https://github.com/chelslava/md-semantic-search/milestone/9) with the pinned [navigator issue](https://github.com/chelslava/md-semantic-search/issues/232).

---

## Where we are — v2.1.0 (2026-11-04)

| Capability | State | Measured in |
|---|---|---|
| Hybrid retrieval (dense + BM25F + fuzzy → RRF) | default | RESEARCH §5, §7 |
| ANN — IVF (default) + HNSW (opt-in, watch-reuse) | shipped | §13, §17 |
| Reranker registry, `gte-reranker-modernbert` default | shipped | §16 |
| Multi-query expansion, HyDE, PRF, recency, graph boost | shipped | §5, §16 |
| Token-budget chunking (RU parity) | shipped | #202 |
| MRL dimension selection, int8 quantization | shipped | §11, §14 |
| MCP 2025-11-25 — negotiation, ping, client sampling | shipped | #146, #197 |
| RAG — `ask`/`chat`, OpenAI-compatible SSE, citations, sessions | shipped | #147, #199 |
| Surfaces — CLI, TUI, daemon HTTP, web UI, Obsidian, VS Code, Windows tray, Docker | shipped | #126, #135, #165 |
| Golden-set regression gate + e2e latency gate (nightly) | shipped | #196, #198 |

## Open decision gates

These are the only places where the retrieval stack may change; each has a measurable trigger defined in RESEARCH.md.

| Gate | Question | Trigger / blocker | Tracked by |
|---|---|---|---|
| RESEARCH §15 | Should `embeddinggemma-300m` replace `e5-base` as the default embedder? | Golden set too thin (48 dev queries) + Gemma license analysis | #226 → #227 |
| RESEARCH §17 | Should HNSW become the default ANN engine? | Full graph build ~20× costlier than IVF; watch-reuse closed by #223 | #228 |
| RESEARCH §12 | Late chunking vs heading-path context? | Requires a long-document ablation slice that does not exist yet | #226 |
| RESEARCH §13 | WASM SIMD dot-product kernels? | Profile >50k chunks — >40% of warm latency in JS float math | #228 |

---

## v2.2.0 — Platform Modernization & Decision Gates (target: December 2026)

- [ ] **Node 20 EOL response** (#224): CI matrix on maintained LTS lines 22/24; runtime deprecation warning for pre-22; `engines` floor stays `>=20.9` until v3.0.0.
- [ ] **Roadmap current** (#225): this document; obsolete v0.x milestones closed.
- [ ] **Golden set 48 → 180+** (#226): balanced RU/EN, explicit cross-lingual pairs, hard negatives, a long-document ablation slice; recalibrated #198 gate.
- [ ] **Default embedder decision** (#227): Gemma license analysis + measurement on the grown golden set; either the default switches (with migration notes) or the refusal is documented with re-evaluation criteria.
- [ ] **HNSW full-build parallelism** (#228): worker_threads / WASM SIMD; gate — ≥3× build speedup at Recall@10 ≥ 0.99, deterministic sidecar; closes or declines the §17(a) revisit condition.
- [ ] **RAG answer quality bench** (#229): citation precision/recall, coverage, refusal correctness for `ask`/`chat` — the first measured quality loop for synthesis, report-only nightly.
- [ ] **Integrations hygiene** (#230): alfred/raycast READMEs + tests, dedicated vscode tests, workspace artifact cleanup.
- [ ] **OpenSSF Scorecard** (#231): scorecard workflow + SHA-pinned actions on top of the existing SBOM/provenance/audit stack.

## v3.0.0 — Breaking platform floor (outlook)

- [ ] `engines` floor → **Node ≥ 22** (breaking; the 18 → 20.9 precedent in v2.0.0). Announced via the #224 deprecation warning well in advance.
- [ ] Absorb whatever the §15/§17 gates decide — a default-embedder or default-engine switch ships here if the migration UX requires a major.

## Deferred by triggers (not scheduled)

- **Late chunking** — prototype only if the #226 ablation slice shows a measured context-recall deficit of heading-path contextualization (§12).
- **Learned sparse (SPLADE-family)** — BM25F is sufficient at the current corpus scale; revisit if target corpora grow an order of magnitude.
- **WASM SIMD sweep kernels** — only if the #228 profiling shows the §13 trigger condition.
- **Vector databases / distributed indexes** — out of the project segment (10k–50k chunks, zero-infra), unchanged.

---

*History: the v0.5 → v1.0.0 plan that led here is preserved in [git history](https://github.com/chelslava/md-semantic-search/commits/main/docs/roadmap.md); its milestones (graph retrieval, zero-copy storage, IDE integrations, local RAG, LTS freeze) all shipped between v1.0.0 and v2.1.0.*

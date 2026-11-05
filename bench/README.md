# bench/

Performance and quality measurement tools for `md-semantic-search`.

| Script | What it measures | Runs in CI |
|---|---|---|
| `e2e.mjs` | **End-to-end latency** (issue #196): `loadIndex` cold/warm, query latency P50/P95/P99 across search profiles (hybrid / semantic / ANN / miss), RSS — on a deterministic generated corpus. Regression gate via `--compare` (+20% tolerance default). | nightly: report always; `--compare` gate when the `MDSS_E2E_COMPARE=1` repo variable is set |
| `ann-recall.mjs` | ANN (IVF) recall vs brute-force sweep quality gate; also prints the HNSW wasm-engine full-build speedup vs the closure path (issue #228, gate ≥3×). | nightly |
| `mrl-recall.mjs` | MRL truncated-dimension recall gate (issue #139). | nightly |
| `benchmark-1m.mjs` | 1M-vector fp32/int8 sweep micro-benchmark. | manual |
| `run-bench.mjs` (in `scripts/`) | Golden-set retrieval quality (nDCG/MRR/Recall) with the committed baseline gate (issue #198). | nightly + PR gate |

## e2e latency (issue #196)

```bash
# default run: 120 files × 10 sections (~1200 chunks), offline hash embedder
node bench/e2e.mjs

# machine-readable report
node bench/e2e.mjs --json

# scale the corpus up
node bench/e2e.mjs --files 400 --sections 12

# real embedding model instead of the offline fake (adds ONNX noise)
node bench/e2e.mjs --model e5-base

# regression gate: fail (exit 1) when any gated metric regresses > 20%
node bench/e2e.mjs --compare bench/fixtures/e2e-latency-baseline.json

# refresh the committed baseline after intentional changes or hardware moves
node bench/e2e.mjs --update-baseline bench/fixtures/e2e-latency-baseline.json
```

Design notes:

- **Deterministic corpus**: files, sections, and the query vocabulary are
  functions of `--seed` (Mulberry32) alone, so run-to-run and commit-to-commit
  comparisons see byte-identical inputs. Nothing is written into the repo —
  the corpus is generated into a temp dir (`--keep` to inspect).
- **Offline embedder by default**: the metric under test is the JS
  sweep/fusion/load path; the deterministic hash embedder keeps runs fast,
  free of model downloads, and reproducible. `--model` switches to a real one.
- **Unique queries per (profile, round)**: the in-memory query-embedding
  cache never short-circuits a measurement.
- **Machine-relative baseline**: `bench/fixtures/e2e-latency-baseline.json`
  records the hardware (`env`) it was taken on. Only enable the CI gate on
  runners matching that hardware; otherwise keep the nightly in report-only
  mode and compare manually.
- **Gated metrics**: load times, per-profile latency tails (P50/P95/P99),
  and RSS. `buildIndexMs` is informational — indexing performance is
  dominated by embedding throughput and tracked by other means.
- Run with `node --expose-gc bench/e2e.mjs` for GC-collected RSS snapshots
  (reported as `gcExposed` in the report either way).

## Golden set v2 (issue #226)

`scripts/run-bench.mjs` measures retrieval quality against
`bench/fixtures/dev-golden.json` — a frozen 26-document RU/EN corpus
(`bench/corpus/notes/`) and a hand-authored query set with graded qrels.

Composition (`mdss-ru-en-golden-v2`): **204 queries** — 186 dev / 12 test /
6 holdout; 100 RU / 104 EN; categories: `natural-question`, `paraphrase`,
`keyword`, `identifier`, `alias`, `hard-negative`, plus the two v2 slices:

- **`cross-lingual`** (27): the query language differs from the language of the
  document that answers it — the tool's headline use case, reported as its own
  bench line for the §15 default-embedder gate.
- **`long-doc-section`** (21): questions answerable only from a deeply nested
  section of a long document (the 10 v2 corpus docs carry frontmatter and
  3–4-level heading trees) — the §12 late-chunking vs heading-path ablation gate.

Grading convention: `3` = directly answers; `2` = the cross-language twin of the
relevant doc, or a partial answer; `0` = a lexically close confuser that must
NOT outrank the target (hard negatives are built from same-topic and cross-topic
pairs, e.g. nginx TLS vs. сертификат-ротация, postgres vs. redis).

Commands:

```bash
# offline sanity run (deterministic hash embedder, no baseline gate)
node scripts/run-bench.mjs --fast --fake --slice dev

# the nightly gate: real e5-base against the committed baseline
node scripts/run-bench.mjs --slice dev --gate bench/fixtures/golden-baseline.json

# after an intentional fixture/corpus change: re-measure and rewrite the baseline
node scripts/run-bench.mjs --slice dev --update-baseline bench/fixtures/golden-baseline.json
```

Extending the set:

1. Corpus changes (new/edited files under `bench/corpus/notes/`) change the
   frozen `corpusHash` — `run-bench.mjs` refuses to run and prints the actual
   fingerprint; paste it into the fixture (the hash is computed exactly like
   `corpusFingerprint()` in `bench/fixture.mjs`: sha256 over
   `path\0hash\0` in sorted path order).
2. Author queries grounded in the actual document content, following the
   grading convention above; every positive qrel must target an existing file.
3. Re-measure with the real model and commit the new
   `bench/fixtures/golden-baseline.json` together with the fixture change.

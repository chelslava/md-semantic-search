# bench/

Performance and quality measurement tools for `md-semantic-search`.

| Script | What it measures | Runs in CI |
|---|---|---|
| `e2e.mjs` | **End-to-end latency** (issue #196): `loadIndex` cold/warm, query latency P50/P95/P99 across search profiles (hybrid / semantic / ANN / miss), RSS — on a deterministic generated corpus. Regression gate via `--compare` (+20% tolerance default). | nightly: report always; `--compare` gate when the `MDSS_E2E_COMPARE=1` repo variable is set |
| `ann-recall.mjs` | ANN (IVF) recall vs brute-force sweep quality gate. | nightly |
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

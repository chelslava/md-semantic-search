# Research & Benchmarks

## Golden-Set Accuracy

The test suite continuously benchmarks retrieval quality against a synthetic and real-world markdown dataset of 340+ test cases.

- **Hit@1 Accuracy**: $\ge 98.5\%$ on exact query intent matches.
- **Recall@10 (ANN / IVF Tier)**: $\ge 95\%$ compared to exhaustive dense scan.
- **Hybrid MRR Improvement**: $+28\%$ over pure vector cosine on keyword-specific technical terms (e.g. error codes, UUIDs, code snippets).

---

## Indexing & Query Latency

| Operation | Scale | Latency / Throughput |
|---|---|---|
| Incremental Re-index | 1 modified file (100-file vault) | **~12 ms** (instant cache hit) |
| Parallel Full Index | 1,000 chunks (`--workers 4`) | **~3.2 s** total time |
| In-Memory Query | 10,000 chunks | **~4.8 ms** (hybrid vector + BM25) |
| ANN IVF Query | 100,000 chunks (`--nprobe 8`) | **~9.1 ms** |

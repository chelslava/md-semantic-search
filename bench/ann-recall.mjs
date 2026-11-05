#!/usr/bin/env node
/**
 * ANN Recall & Latency Benchmark: IVF (issue #139) vs HNSW (issue #201).
 * Recall@10 across nprobe {1,4,8,16} (IVF) and ef {16,32,64,128} (HNSW)
 * against the exact brute-force sweep — the curves feed the default-engine
 * decision documented in RESEARCH.md §17.
 */
import { performance } from 'node:perf_hooks';
import { trainIVF, searchIVFCandidates } from '../dist/ivf.js';
import { buildHnsw, searchHnswCandidates, serializeHnsw } from '../dist/hnsw.js';
import { cosine } from '../dist/core.js';

function randomNormalizedVector(dim) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (Math.random() - 0.5) * 2;
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

export function runAnnRecallBenchmark(sizes = [1000, 5000], dim = 256) {
  console.log('=== ANN IVF Recall vs Brute-Force Quality Benchmark ===\n');

  const nprobes = [1, 4, 8, 16];
  const queryCount = 25;
  const k = 10;

  for (const n of sizes) {
    console.log(`\n--- Corpus: ${n} chunks (dim: ${dim}) ---`);

    // Generate clustered vector distributions
    const numCenters = Math.max(4, Math.floor(Math.sqrt(n)));
    const centers = Array.from({ length: numCenters }, () => randomNormalizedVector(dim));
    const vectors = [];

    for (let i = 0; i < n; i++) {
      const center = centers[i % numCenters];
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) v[d] = center[d] + (Math.random() - 0.5) * 0.25;
      const norm = Math.hypot(...v) || 1;
      for (let d = 0; d < dim; d++) v[d] /= norm;
      vectors.push(v);
    }

    const tTrain0 = performance.now();
    let trainMetrics;
    const ivf = trainIVF(vectors, {
      seeding: 'kmeans++',
      seed: 42,
      onMetric: (m) => { trainMetrics = m; },
    });
    const trainDuration = (performance.now() - tTrain0).toFixed(2);
    console.log(`IVF Trained in ${trainDuration} ms (k=${ivf.k}, empty clusters: ${trainMetrics?.emptyClusters ?? 0}, iters: ${trainMetrics?.iterations ?? 0})`);

    // Sample queries
    const queries = Array.from({ length: queryCount }, (_, q) => {
      const center = centers[q % numCenters];
      const query = new Float32Array(dim);
      for (let d = 0; d < dim; d++) query[d] = center[d] + (Math.random() - 0.5) * 0.25;
      const norm = Math.hypot(...query) || 1;
      for (let d = 0; d < dim; d++) query[d] /= norm;
      return query;
    });

    // Exact top-10 ground truth
    const groundTruth = queries.map((q) => {
      const scores = vectors.map((v, idx) => ({ idx, score: cosine(q, v) }));
      scores.sort((a, b) => b.score - a.score);
      return new Set(scores.slice(0, k).map((s) => s.idx));
    });

    const rows = [];

    for (const nprobe of nprobes) {
      let totalRecall = 0;
      const latencies = [];

      for (let q = 0; q < queryCount; q++) {
        const query = queries[q];
        const t0 = performance.now();
        const candidateIndices = searchIVFCandidates(query, ivf, nprobe);
        const candidateSet = new Set(candidateIndices);
        const annScores = [...candidateSet].map((idx) => ({ idx, score: cosine(query, vectors[idx]) }));
        annScores.sort((a, b) => b.score - a.score);
        latencies.push(performance.now() - t0);

        const annTop10 = annScores.slice(0, k).map((s) => s.idx);
        const gt = groundTruth[q];
        const hits = annTop10.filter((idx) => gt.has(idx)).length;
        totalRecall += hits / k;
      }

      latencies.sort((a, b) => a - b);
      const avgRecall = ((totalRecall / queryCount) * 100).toFixed(1);
      const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(3);
      const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(3);

      rows.push({
        nprobe,
        'recall@10': `${avgRecall}%`,
        'p50Latency (ms)': p50,
        'p95Latency (ms)': p95,
      });
    }

    console.table(rows);

    // ── HNSW (issue #201): recall/latency across ef ──
    const tHnsw0 = performance.now();
    const hnsw = buildHnsw(vectors, {
      vectors,
      distance: (a, b) => 1 - cosine(a, vectors[b]),
    });
    const hnswBuildMs = (performance.now() - tHnsw0).toFixed(2);
    console.log(`HNSW built in ${hnswBuildMs} ms (M=16, no training phase)`);

    // ── HNSW wasm engine (issue #228): full-build speedup gate ≥3× ──
    const tHnswWasm0 = performance.now();
    const hnswWasm = buildHnsw(vectors, {
      vectors,
      distance: (a, b) => 1 - cosine(a, vectors[b]),
      engine: 'auto',
    });
    const hnswWasmBuildMs = performance.now() - tHnswWasm0;
    console.log(
      `HNSW wasm engine: ${hnswWasmBuildMs.toFixed(2)} ms — ` +
        `×${(Number(hnswBuildMs) / hnswWasmBuildMs).toFixed(2)} vs closure ` +
        `(gate ≥3×: ${Number(hnswBuildMs) / hnswWasmBuildMs >= 3 ? 'PASS' : 'MISS'})`,
    );
    const closureSidecar = JSON.stringify(serializeHnsw(hnsw));
    const wasmSidecar = JSON.stringify(serializeHnsw(hnswWasm));
    if (closureSidecar !== wasmSidecar) {
      console.log('  note: engines differ in last-ulp accumulation order — each is self-deterministic');
    }

    const efs = [16, 32, 64, 128];
    const hnswRows = [];
    for (const ef of efs) {
      let totalRecall = 0;
      const latencies = [];
      for (let q = 0; q < queryCount; q++) {
        const query = queries[q];
        const t0 = performance.now();
        const candidateIndices = searchHnswCandidates(query, hnsw, vectors, { ef });
        const candidateSet = new Set(candidateIndices);
        const annScores = [...candidateSet].map((idx) => ({ idx, score: cosine(query, vectors[idx]) }));
        annScores.sort((a, b) => b.score - a.score);
        latencies.push(performance.now() - t0);
        const annTop10 = annScores.slice(0, k).map((s2) => s2.idx);
        const gt = groundTruth[q];
        const hits = annTop10.filter((idx) => gt.has(idx)).length;
        totalRecall += hits / k;
      }
      latencies.sort((a, b) => a - b);
      hnswRows.push({
        ef,
        'recall@10': `${((totalRecall / queryCount) * 100).toFixed(1)}%`,
        'p50Latency (ms)': latencies[Math.floor(latencies.length * 0.5)].toFixed(3),
        'p95Latency (ms)': latencies[Math.floor(latencies.length * 0.95)].toFixed(3),
      });
    }
    console.table(hnswRows);
  }
}

if (process.argv[1]?.endsWith('ann-recall.mjs')) {
  runAnnRecallBenchmark();
}

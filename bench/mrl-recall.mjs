#!/usr/bin/env node
/**
 * MRL Dimension Selection Benchmark & Recall Gate (issue #143).
 * Evaluates memory, cosine sweep latency, and top-k recall across {full, 1/2, 1/4} dims.
 */
import { performance } from 'node:perf_hooks';
import { truncateAndNormalizeVector, cosine } from '../dist/index.js';

function generateRandomVector(dim) {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = (Math.random() - 0.5) * 2;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

export function runMrlBenchmark(corpusSize = 5000, nativeDim = 1024, dims = [1024, 512, 256, 128]) {
  console.log(`=== MRL Dimension Selection Benchmark (Corpus: ${corpusSize} chunks, Native Dim: ${nativeDim}) ===\n`);

  // Generate ground truth vectors
  const fullVectors = new Array(corpusSize);
  for (let i = 0; i < corpusSize; i++) {
    fullVectors[i] = generateRandomVector(nativeDim);
  }

  const queryCount = 20;
  const queries = new Array(queryCount);
  for (let i = 0; i < queryCount; i++) {
    queries[i] = generateRandomVector(nativeDim);
  }

  // Baseline top-10 ground truth indices for queries using full dimension
  const groundTruth = queries.map((q) => {
    const scores = fullVectors.map((v, idx) => ({ idx, score: cosine(q, v) }));
    scores.sort((a, b) => b.score - a.score);
    return new Set(scores.slice(0, 10).map((s) => s.idx));
  });

  const results = [];

  for (const targetDim of dims) {
    const memBytes = corpusSize * targetDim * 4;
    const memMB = (memBytes / (1024 * 1024)).toFixed(2);

    // Truncate vectors
    const truncatedVectors = fullVectors.map((v) =>
      targetDim === nativeDim ? v : truncateAndNormalizeVector(v, targetDim, true)
    );
    const truncatedQueries = queries.map((q) =>
      targetDim === nativeDim ? q : truncateAndNormalizeVector(q, targetDim, true)
    );

    // Measure sweep latency
    const latencies = [];
    let totalRecallAt10 = 0;

    for (let qIdx = 0; qIdx < queryCount; qIdx++) {
      const q = truncatedQueries[qIdx];
      const t0 = performance.now();
      const scores = truncatedVectors.map((v, idx) => ({ idx, score: cosine(q, v) }));
      scores.sort((a, b) => b.score - a.score);
      latencies.push(performance.now() - t0);

      const top10 = scores.slice(0, 10).map((s) => s.idx);
      const gt = groundTruth[qIdx];
      const hits = top10.filter((idx) => gt.has(idx)).length;
      totalRecallAt10 += hits / 10;
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(3);
    const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(3);
    const recallAt10 = ((totalRecallAt10 / queryCount) * 100).toFixed(1);

    results.push({
      dim: targetDim,
      ratio: `${Math.round((targetDim / nativeDim) * 100)}%`,
      memMB: `${memMB} MB`,
      p50Latency: `${p50} ms`,
      p95Latency: `${p95} ms`,
      recallAt10: `${recallAt10}%`,
    });
  }

  console.table(results);
  return results;
}

if (process.argv[1]?.endsWith('mrl-recall.mjs')) {
  runMrlBenchmark();
}

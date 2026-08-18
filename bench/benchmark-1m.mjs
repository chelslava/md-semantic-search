#!/usr/bin/env node
/**
 * Large-Scale 1M+ Chunk Retrieval Benchmark & Latency Suite (issue #105).
 * Measures throughput, query latency percentiles (P50, P95, P99), and RAM footprint.
 */
import { quantizeToInt8, asymmetricCosineInt8 } from '../dist/quantization.js';
import { cosine } from '../dist/core.js';

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

export function runScaleBenchmark(chunkCount = 100000, dim = 384) {
  const queryVec = generateRandomVector(dim);

  // Generate chunks
  const startTime = performance.now();
  const rawVectors = new Array(chunkCount);
  const int8Vectors = new Array(chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const v = generateRandomVector(dim);
    rawVectors[i] = v;
    int8Vectors[i] = quantizeToInt8(v);
  }

  const buildDuration = performance.now() - startTime;

  // Measure FP32 Latency
  const fp32Latencies = [];
  for (let q = 0; q < 50; q++) {
    const t0 = performance.now();
    let maxSim = -1;
    for (let i = 0; i < chunkCount; i++) {
      const sim = cosine(queryVec, rawVectors[i]);
      if (sim > maxSim) maxSim = sim;
    }
    fp32Latencies.push(performance.now() - t0);
  }

  // Measure INT8 Latency
  const int8Latencies = [];
  for (let q = 0; q < 50; q++) {
    const t0 = performance.now();
    let maxSim = -1;
    for (let i = 0; i < chunkCount; i++) {
      const sim = asymmetricCosineInt8(queryVec, int8Vectors[i]);
      if (sim > maxSim) maxSim = sim;
    }
    int8Latencies.push(performance.now() - t0);
  }

  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[idx];
  };

  const results = {
    chunks: chunkCount,
    dimension: dim,
    generationTimeMs: Math.round(buildDuration),
    throughputChunksPerSec: Math.round((chunkCount / (buildDuration / 1000))),
    fp32: {
      memoryMb: Math.round((chunkCount * dim * 4) / (1024 * 1024)),
      latencyP50Ms: Number(percentile(fp32Latencies, 50).toFixed(2)),
      latencyP95Ms: Number(percentile(fp32Latencies, 95).toFixed(2)),
      latencyP99Ms: Number(percentile(fp32Latencies, 99).toFixed(2)),
    },
    int8: {
      memoryMb: Math.round((chunkCount * dim * 1) / (1024 * 1024)),
      latencyP50Ms: Number(percentile(int8Latencies, 50).toFixed(2)),
      latencyP95Ms: Number(percentile(int8Latencies, 95).toFixed(2)),
      latencyP99Ms: Number(percentile(int8Latencies, 99).toFixed(2)),
    },
  };

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('benchmark-1m.mjs')) {
  const count = Number(process.argv[2]) || 100000;
  process.stdout.write(`Running scale benchmark on ${count.toLocaleString()} chunks...\n`);
  const out = runScaleBenchmark(count, 384);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

import { cosine } from './core.js';
import { createWasmSweepEngine } from './sweep-kernel.js';

export interface IVFIndex {
  dim: number;
  k: number;
  centroids: Float32Array; // Flattened k * dim
  clusters: number[][]; // clusters[clusterIndex] = array of chunk indices
}

export interface SerializedIVF {
  dim: number;
  k: number;
  centroids: string; // Base64 encoded Float32Array
  clusters: number[][];
}

export interface TrainIVFOptions {
  k?: number;
  maxIterations?: number;
  seeding?: 'kmeans++' | 'spread';
  seed?: number;
  onMetric?: (metric: { emptyClusters: number; iterations: number }) => void;
  /**
   * issue #268 (RESEARCH §22): 'auto' (default) scores the k-means sweeps
   * through the §13 WASM SIMD kernel (per-centroid rows against the corpus
   * matrix) and silently falls back to the JS path when the module cannot
   * compile; 'js' forces the historical JS path. The SIMD accumulation order
   * differs from JS in the last ulp, so the two engines are each
   * self-consistent but not cross-identical (the #228 contract) — golden-gate
   * tolerance governs, see §22.
   */
  engine?: 'auto' | 'js';
}

export const ANN_THRESHOLD = 500;
export const DEFAULT_NPROBE = 8;

/**
 * Fast, deterministic pseudo-random number generator (Mulberry32).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Train a Spherical K-Means IVF index over normalized vectors using k-means++ seeding.
 */
export function trainIVF(
  vectors: Float32Array[],
  options: TrainIVFOptions = {}
): IVFIndex {
  const n = vectors.length;
  if (n === 0) {
    return { dim: 0, k: 0, centroids: new Float32Array(0), clusters: [] };
  }
  const dim = vectors[0].length;
  const targetK = options.k ?? Math.min(256, Math.max(2, Math.floor(Math.sqrt(n))));
  const k = Math.min(targetK, n);
  const maxIterations = options.maxIterations ?? 20;
  const seeding = options.seeding ?? 'kmeans++';

  const centroids = new Float32Array(k * dim);

  // issue #268 (RESEARCH §22): score the k-means sweeps through the §13 SIMD
  // kernel. The corpus rows are copied into WASM memory once (fp32 rows); a
  // compile failure or ragged rows degrade to the JS path below. All vectors
  // are unit-normalized, so the kernel's raw dot IS the cosine — the same
  // arithmetic class as core.cosine, differing only in the last-ulp
  // accumulation order (4-lane vs 8-lane).
  const engine =
    options.engine === 'js' ? null : createWasmSweepEngine(vectors, null, dim, n);

  // Identity row indices for whole-corpus sweeps (reused across all passes).
  const identity = engine ? new Uint32Array(n) : null;
  if (identity) {
    for (let i = 0; i < n; i++) identity[i] = i;
  }
  const sweepScores = engine ? new Float32Array(n) : null;

  if (seeding === 'spread' || n <= k) {
    // Deterministic spread
    const step = Math.floor(n / k);
    for (let c = 0; c < k; c++) {
      const src = vectors[c * step];
      centroids.set(src, c * dim);
    }
  } else if (engine && identity && sweepScores) {
    // SIMD k-means++ — same D^2 recurrence as the JS path, each D^2 update
    // replaced by one whole-corpus sweep against the new centroid.
    const minDistSq = new Float64Array(n);
    const sweepD2 = (cOffset: number) => {
      engine.sweep(centroids.subarray(cOffset, cOffset + dim), identity, sweepScores);
      for (let i = 0; i < n; i++) {
        const distSq = Math.max(0, 1 - sweepScores[i]);
        if (cOffset === 0) minDistSq[i] = distSq;
        else if (distSq < minDistSq[i]) minDistSq[i] = distSq;
      }
    };

    // Deterministic k-means++ seeding with D^2 weighted probability
    const rng = mulberry32(options.seed ?? 42);
    const firstIdx = Math.floor(rng() * n);
    centroids.set(vectors[firstIdx], 0);
    sweepD2(0);

    for (let c = 1; c < k; c++) {
      let sumDistSq = 0;
      for (let i = 0; i < n; i++) {
        sumDistSq += minDistSq[i];
      }

      let chosenIdx = -1;
      if (sumDistSq > 1e-12) {
        const target = rng() * sumDistSq;
        let cumulative = 0;
        for (let i = 0; i < n; i++) {
          cumulative += minDistSq[i];
          if (cumulative >= target) {
            chosenIdx = i;
            break;
          }
        }
      }
      if (chosenIdx === -1 || chosenIdx >= n) {
        chosenIdx = Math.floor(rng() * n);
      }

      centroids.set(vectors[chosenIdx], c * dim);
      sweepD2(c * dim);
    }
  } else {
    // Deterministic k-means++ seeding with D^2 weighted probability
    const rng = mulberry32(options.seed ?? 42);
    const firstIdx = Math.floor(rng() * n);
    centroids.set(vectors[firstIdx], 0);

    const minDistSq = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const cos = cosine(vectors[i], centroids, 0);
      minDistSq[i] = Math.max(0, 1 - cos);
    }

    for (let c = 1; c < k; c++) {
      let sumDistSq = 0;
      for (let i = 0; i < n; i++) {
        sumDistSq += minDistSq[i];
      }

      let chosenIdx = -1;
      if (sumDistSq > 1e-12) {
        const target = rng() * sumDistSq;
        let cumulative = 0;
        for (let i = 0; i < n; i++) {
          cumulative += minDistSq[i];
          if (cumulative >= target) {
            chosenIdx = i;
            break;
          }
        }
      }
      if (chosenIdx === -1 || chosenIdx >= n) {
        chosenIdx = Math.floor(rng() * n);
      }

      centroids.set(vectors[chosenIdx], c * dim);

      for (let i = 0; i < n; i++) {
        const cos = cosine(vectors[i], centroids, c * dim);
        const distSq = Math.max(0, 1 - cos);
        if (distSq < minDistSq[i]) {
          minDistSq[i] = distSq;
        }
      }
    }
  }

  let clusters: number[][] = Array.from({ length: k }, () => []);
  const assignments = new Int32Array(n).fill(-1);
  let totalEmptyClusters = 0;
  let finalIterations = 0;

  // SIMD assignment scratch (allocated once, reset per iteration).
  const bestScore = engine ? new Float32Array(n) : null;
  const bestCluster = engine ? new Int32Array(n) : null;

  for (let iter = 0; iter < maxIterations; iter++) {
    finalIterations = iter + 1;
    let changed = 0;
    const newClusters: number[][] = Array.from({ length: k }, () => []);

    // 1. Assign each vector to closest centroid (highest cosine / dot product)
    if (engine && bestScore && bestCluster && identity && sweepScores) {
      // issue #268: per-centroid whole-corpus sweeps with a running argmax —
      // the same first-max-wins tie semantics as the JS loop (centroids in
      // ascending order, strict >).
      bestScore.fill(-Infinity);
      for (let c = 0; c < k; c++) {
        engine.sweep(centroids.subarray(c * dim, (c + 1) * dim), identity, sweepScores);
        for (let i = 0; i < n; i++) {
          if (sweepScores[i] > bestScore[i]) {
            bestScore[i] = sweepScores[i];
            bestCluster[i] = c;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        const best = bestCluster[i];
        if (assignments[i] !== best) {
          assignments[i] = best;
          changed++;
        }
        newClusters[best].push(i);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = vectors[i];
        let bestScoreJs = -Infinity;
        let bestClusterJs = 0;

        for (let c = 0; c < k; c++) {
          const score = cosine(v, centroids, c * dim);
          if (score > bestScoreJs) {
            bestScoreJs = score;
            bestClusterJs = c;
          }
        }

        if (assignments[i] !== bestClusterJs) {
          assignments[i] = bestClusterJs;
          changed++;
        }
        newClusters[bestClusterJs].push(i);
      }
    }

    clusters = newClusters;

    // 2. Recompute centroids & rescue empty clusters
    let emptyCount = 0;
    for (let c = 0; c < k; c++) {
      const members = clusters[c];
      if (members.length === 0) {
        emptyCount++;
        // Reassign to a vector from the largest cluster
        let largest = 0;
        for (let j = 1; j < k; j++) {
          if (clusters[j].length > clusters[largest].length) largest = j;
        }
        if (clusters[largest].length > 1) {
          const stolenIdx = clusters[largest].pop()!;
          clusters[c].push(stolenIdx);
          assignments[stolenIdx] = c;
          centroids.set(vectors[stolenIdx], c * dim);
        }
        continue;
      }

      const cOffset = c * dim;
      for (let d = 0; d < dim; d++) centroids[cOffset + d] = 0;

      for (const idx of members) {
        const v = vectors[idx];
        for (let d = 0; d < dim; d++) {
          centroids[cOffset + d] += v[d];
        }
      }

      // L2 Normalize
      let normSq = 0;
      for (let d = 0; d < dim; d++) {
        const val = centroids[cOffset + d];
        normSq += val * val;
      }
      const norm = Math.sqrt(normSq) || 1;
      for (let d = 0; d < dim; d++) {
        centroids[cOffset + d] /= norm;
      }
    }

    totalEmptyClusters = emptyCount;
    if (changed === 0) break;
  }

  options.onMetric?.({ emptyClusters: totalEmptyClusters, iterations: finalIterations });

  return { dim, k, centroids, clusters };
}

/**
 * Probe top-nprobe closest centroids and return candidate chunk indices.
 */
export function searchIVFCandidates(
  queryVec: Float32Array,
  ivf: IVFIndex,
  nprobe: number = DEFAULT_NPROBE
): number[] {
  const { k, dim, centroids, clusters } = ivf;
  if (k === 0 || clusters.length === 0) return [];

  const actualNprobe = Math.min(Math.max(1, nprobe), k);

  // Compute similarities to all centroids
  const scores: Array<{ cluster: number; score: number }> = [];
  for (let c = 0; c < k; c++) {
    const score = cosine(queryVec, centroids, c * dim);
    scores.push({ cluster: c, score });
  }

  // Sort descending by similarity
  scores.sort((a, b) => b.score - a.score);

  const candidates: number[] = [];
  for (let i = 0; i < actualNprobe; i++) {
    const clusterIdx = scores[i].cluster;
    const memberIndices = clusters[clusterIdx];
    for (let j = 0; j < memberIndices.length; j++) {
      candidates.push(memberIndices[j]);
    }
  }

  return candidates;
}

/**
 * Serialize IVFIndex to plain JSON-compatible object.
 */
export function serializeIVF(ivf: IVFIndex): SerializedIVF {
  const b64 = Buffer.from(
    ivf.centroids.buffer,
    ivf.centroids.byteOffset,
    ivf.centroids.byteLength
  ).toString('base64');

  return {
    dim: ivf.dim,
    k: ivf.k,
    centroids: b64,
    clusters: ivf.clusters,
  };
}

/**
 * Deserialize JSON object back to IVFIndex with hardened validation.
 */
export function deserializeIVF(raw: unknown, expectedChunksCount?: number): IVFIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid IVF payload: expected JSON object — run `mdss index` to rebuild');
  }
  const obj = raw as Record<string, unknown>;
  const dim = obj.dim;
  const k = obj.k;
  if (
    typeof dim !== 'number' ||
    !Number.isSafeInteger(dim) ||
    dim <= 0 ||
    typeof k !== 'number' ||
    !Number.isSafeInteger(k) ||
    k <= 0
  ) {
    throw new Error('invalid IVF payload: invalid dim or k — run `mdss index` to rebuild');
  }
  if (typeof obj.centroids !== 'string' || obj.centroids.length === 0) {
    throw new Error('invalid IVF payload: centroids must be a base64 string — run `mdss index` to rebuild');
  }
  const buf = Buffer.from(obj.centroids, 'base64');
  if (buf.byteLength % 4 !== 0 || buf.byteLength !== k * dim * 4) {
    throw new Error(
      `invalid IVF payload: centroids buffer has ${buf.byteLength} bytes, expected ${k * dim * 4} bytes — run \`mdss index\` to rebuild`
    );
  }
  const centroids = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  for (let i = 0; i < centroids.length; i++) {
    if (!Number.isFinite(centroids[i])) {
      throw new Error(`invalid IVF payload: non-finite centroid value at index ${i} — run \`mdss index\` to rebuild`);
    }
  }

  if (!Array.isArray(obj.clusters)) {
    throw new Error('invalid IVF payload: clusters must be an array — run `mdss index` to rebuild');
  }
  if (obj.clusters.length !== k) {
    throw new Error(
      `invalid IVF payload: clusters array has length ${obj.clusters.length}, expected ${k} — run \`mdss index\` to rebuild`
    );
  }

  const clusters: number[][] = new Array(k);
  for (let c = 0; c < k; c++) {
    const list = obj.clusters[c];
    if (!Array.isArray(list)) {
      throw new Error(`invalid IVF payload: cluster ${c} must be an array — run \`mdss index\` to rebuild`);
    }
    const validatedCluster: number[] = new Array(list.length);
    const seen = new Set<number>();
    for (let j = 0; j < list.length; j++) {
      const idx = list[j];
      if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0) {
        throw new Error(
          `invalid IVF payload: cluster ${c} contains non-integer index "${idx}" — run \`mdss index\` to rebuild`
        );
      }
      if (expectedChunksCount !== undefined && idx >= expectedChunksCount) {
        throw new Error(
          `invalid IVF payload: chunk index ${idx} out of range [0, ${expectedChunksCount}) — run \`mdss index\` to rebuild`
        );
      }
      if (seen.has(idx)) {
        throw new Error(
          `invalid IVF payload: duplicate chunk index ${idx} in cluster ${c} — run \`mdss index\` to rebuild`
        );
      }
      seen.add(idx);
      validatedCluster[j] = idx;
    }
    clusters[c] = validatedCluster;
  }

  return { dim, k, centroids, clusters };
}

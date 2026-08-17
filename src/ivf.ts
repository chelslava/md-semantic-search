import { cosine } from './core.js';

export interface IVFIndex {
  dim: number;
  k: number;
  centroids: Float32Array; // Flattened k * dim
  clusters: number[][];    // clusters[clusterIndex] = array of chunk indices
}

export interface SerializedIVF {
  dim: number;
  k: number;
  centroids: string; // Base64 encoded Float32Array
  clusters: number[][];
}

export const ANN_THRESHOLD = 500;
export const DEFAULT_NPROBE = 8;

/**
 * Train a Spherical K-Means IVF index over normalized vectors.
 */
export function trainIVF(
  vectors: Float32Array[],
  options: { k?: number; maxIterations?: number } = {}
): IVFIndex {
  const n = vectors.length;
  if (n === 0) {
    return { dim: 0, k: 0, centroids: new Float32Array(0), clusters: [] };
  }
  const dim = vectors[0].length;
  const targetK = options.k ?? Math.min(256, Math.max(2, Math.floor(Math.sqrt(n))));
  const k = Math.min(targetK, n);
  const maxIterations = options.maxIterations ?? 20;

  // Initialize centroids using deterministic spread or k-means++
  const centroids = new Float32Array(k * dim);
  const step = Math.floor(n / k);
  for (let c = 0; c < k; c++) {
    const src = vectors[c * step];
    centroids.set(src, c * dim);
  }

  let clusters: number[][] = Array.from({ length: k }, () => []);
  const assignments = new Int32Array(n).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    const newClusters: number[][] = Array.from({ length: k }, () => []);

    // 1. Assign each vector to closest centroid (highest cosine / dot product)
    for (let i = 0; i < n; i++) {
      const v = vectors[i];
      let bestScore = -Infinity;
      let bestCluster = 0;

      for (let c = 0; c < k; c++) {
        const score = cosine(v, centroids, c * dim);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = c;
        }
      }

      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed++;
      }
      newClusters[bestCluster].push(i);
    }

    clusters = newClusters;

    // 2. Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = clusters[c];
      if (members.length === 0) {
        // If empty, reassign to a vector from the largest cluster
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

    if (changed === 0) break;
  }

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
 * Deserialize JSON object back to IVFIndex.
 */
export function deserializeIVF(raw: any): IVFIndex {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid IVF payload: expected object');
  }
  const dim = Number(raw.dim);
  const k = Number(raw.k);
  if (!Number.isInteger(dim) || dim <= 0 || !Number.isInteger(k) || k <= 0) {
    throw new Error('invalid IVF payload: invalid dim or k');
  }
  const buf = Buffer.from(raw.centroids, 'base64');
  const centroids = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const clusters = Array.isArray(raw.clusters) ? raw.clusters : [];

  return { dim, k, centroids, clusters };
}

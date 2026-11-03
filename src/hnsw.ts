/**
 * Pure JS/TS HNSW approximate nearest neighbor index (issue #201).
 *
 * Hierarchical Navigable Small World graphs (Malkov & Yashunin 2016): no
 * training phase, incremental inserts, ~99% recall with sublinear search —
 * the counterpart of the k-means IVF in `ivf.ts`, sharing its contract:
 * build → serialize → persist → search as a candidate pre-filter in front
 * of the exact sweep. Cosine distance (1 − dot on normalized vectors) is
 * computed through an injected distance function so int8 zero-copy vectors
 * work unchanged. Deleted nodes are tombstones — searches skip them, which
 * is what lets the incremental watch rebuild reuse a persisted graph.
 */

/** Deterministic PRNG for level assignment (same family as ivf.ts). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HnswIndex {
  dim: number;
  /** Max links per node on layers > 0. */
  M: number;
  /** Random level seed — rebuilds from the same insertion order are identical. */
  seed: number;
  /** Node index of the graph entry (top layer). */
  entryPoint: number;
  /** Highest layer in the graph. */
  maxLevel: number;
  /** levels[i] = top layer of node i. */
  levels: number[];
  /** neighbors[i][l] = link list of node i on layer l (l ≤ levels[i]). */
  neighbors: number[][][];
  /** Tombstoned node indices — skipped by search, kept for graph connectivity. */
  deleted: Set<number>;
}

export interface SerializedHnsw {
  format: 'hnsw-v1';
  dim: number;
  M: number;
  seed: number;
  entryPoint: number;
  maxLevel: number;
  count: number;
  levels: number[];
  neighbors: number[][][];
  deleted: number[];
}

export interface BuildHnswOptions {
  M?: number;
  seed?: number;
  /**
   * Distance between the query/node vector at `a` and the stored node `b` —
   * LOWER is closer (cosine distance: `1 − dot(a, vectors[b])`). Injected so
   * int8 zero-copy and norm-cached sweeps work unchanged.
   */
  distance: (a: Float32Array | Int8Array | number[], b: number) => number;
  vectors: Array<Float32Array | Int8Array | number[]>;
}

export const DEFAULT_HNSW_M = 16;
export const DEFAULT_HNSW_EF = 64;

export function buildHnsw(
  vectors: Array<Float32Array | Int8Array | number[]>,
  options: BuildHnswOptions
): HnswIndex {
  const hnsw: HnswIndex = {
    dim: vectors[0]?.length ?? 0,
    M: options.M ?? DEFAULT_HNSW_M,
    seed: options.seed ?? 42,
    entryPoint: -1,
    maxLevel: -1,
    levels: [],
    neighbors: [],
    deleted: new Set(),
  };
  for (let i = 0; i < vectors.length; i++) insertHnsw(hnsw, i, options.distance, options.vectors);
  return hnsw;
}

/**
 * Insert node `idx` (vector index) into the graph. Incremental — new indices
 * attach to the existing structure without a rebuild; vectors for nodes NOT
 * yet inserted are read from `vectors` when needed, so the caller can insert
 * lazily. Tombstoned indices can be re-inserted (undeletes).
 */
export function insertHnsw(
  hnsw: HnswIndex,
  idx: number,
  distance: (a: Float32Array | Int8Array | number[], b: number) => number,
  vectors: Array<Float32Array | Int8Array | number[]>
): void {
  const vec = vectors[idx];
  if (!vec) throw new Error(`hnsw insert: no vector at index ${idx}`);
  if (hnsw.levels[idx] !== undefined && !hnsw.deleted.has(idx)) {
    throw new Error(`hnsw insert: node ${idx} already present`);
  }
  hnsw.deleted.delete(idx);

  const M = hnsw.M;
  const M0 = M * 2;
  const mL = 1 / Math.log(M);
  const rng = mulberry32(hnsw.seed + idx * 2654435761);

  const u = Math.max(rng(), Number.MIN_VALUE);
  const level = Math.min(Math.floor(-Math.log(u) * mL), 64);
  hnsw.levels[idx] = level;
  hnsw.neighbors[idx] = Array.from({ length: level + 1 }, () => []);

  if (hnsw.entryPoint < 0) {
    hnsw.entryPoint = idx;
    hnsw.maxLevel = level;
    return;
  }

  const qDist = (node: number) => distance(vec, node);

  // 1. Greedy descent through layers above the node's level
  let ep = hnsw.entryPoint;
  let epDist = qDist(ep);
  for (let l = hnsw.maxLevel; l > level; l--) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const nb of hnsw.neighbors[ep][l] ?? []) {
        const d = qDist(nb);
        if (d < epDist) {
          epDist = d;
          ep = nb;
          changed = true;
        }
      }
    }
  }

  // 2. Insert on each layer from min(level, maxLevel) down to 0
  const pairwise = (a: number, b: number) => distance(vectors[a], b);
  for (let l = Math.min(level, hnsw.maxLevel); l >= 0; l--) {
    const efC = Math.max(M0, DEFAULT_HNSW_EF);
    const candidates = searchLayer(hnsw, qDist, ep, epDist, l, efC);
    const cap = l === 0 ? M0 : M;
    // Algorithm 4: diversity-aware neighbor selection keeps the graph
    // navigable — a candidate is skipped only when it is CLOSER to an
    // already-selected neighbor than to the query
    const selected = selectNeighborsHeuristic(candidates, cap, pairwise);
    hnsw.neighbors[idx][l] = selected.map((c) => c.node);
    for (const { node } of selected) {
      const links = hnsw.neighbors[node][l];
      if (!links.includes(idx)) links.push(idx);
      if (links.length > cap) {
        // re-select the neighbor's own links with the same heuristic — the
        // diversity rule preserves connectivity instead of blind top-M,
        // which used to sever the just-added edge and strand whole regions
        const pruned = selectNeighborsHeuristic(
          links.map((n) => ({ node: n, dist: pairwise(node, n) })),
          cap,
          pairwise,
        );
        hnsw.neighbors[node][l] = pruned.map((c) => c.node);
      }
    }
    if (candidates.length > 0) {
      ep = candidates[0].node;
      epDist = candidates[0].dist;
    }
  }

  if (level > hnsw.maxLevel) {
    hnsw.maxLevel = level;
    hnsw.entryPoint = idx;
  }
}

/** Tombstone a node — searches skip it; the graph keeps it for connectivity. */
export function deleteHnsw(hnsw: HnswIndex, idx: number): void {
  if (hnsw.levels[idx] !== undefined) hnsw.deleted.add(idx);
}

/** ef-search one layer, returning the closest `ef` live candidates (closest first). */
function searchLayer(
  hnsw: HnswIndex,
  qDist: (node: number) => number,
  ep: number,
  epDist: number,
  layer: number,
  ef: number
): Array<{ node: number; dist: number }> {
  const visited = new Set<number>([ep]);
  // max-heap by dist via simple sorted insertion (candidate lists are small)
  const candidates: Array<{ node: number; dist: number }> = [{ node: ep, dist: epDist }];
  const results: Array<{ node: number; dist: number }> =
    hnsw.deleted.has(ep) ? [] : [{ node: ep, dist: epDist }];

  while (candidates.length > 0) {
    const current = candidates.shift()!;
    const worst = results.length >= ef ? results[results.length - 1].dist : Infinity;
    if (current.dist > worst) break;

    for (const nb of hnsw.neighbors[current.node][layer] ?? []) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      const d = qDist(nb);
      const worstNow = results.length >= ef ? results[results.length - 1].dist : Infinity;
      if (d < worstNow || results.length < ef) {
        candidates.push({ node: nb, dist: d });
        candidates.sort((a, b) => a.dist - b.dist);
        if (!hnsw.deleted.has(nb)) {
          results.push({ node: nb, dist: d });
          results.sort((a, b) => a.dist - b.dist);
          if (results.length > ef) results.pop();
        }
      }
    }
  }
  return results;
}

/**
 * Algorithm 4 of the HNSW paper (Malkov & Yashunin 2016): candidates sorted
 * by distance to the query enter the result in order; a candidate is skipped
 * when it is closer to some already-selected neighbor than to the query
 * (redundant direction). `pairwise(a, b)` measures node-to-node distance.
 * If fewer than `m` survive (disconnected candidate set), the closest
 * leftovers backfill so the link count stays useful.
 */
export function selectNeighborsHeuristic(
  candidates: Array<{ node: number; dist: number }>,
  m: number,
  pairwise: (a: number, b: number) => number
): Array<{ node: number; dist: number }> {
  const sorted = [...candidates].sort((a, b) => a.dist - b.dist);
  const result: Array<{ node: number; dist: number }> = [];
  const skipped: Array<{ node: number; dist: number }> = [];
  for (const cand of sorted) {
    if (result.length >= m) break;
    let dominated = false;
    for (const chosen of result) {
      if (pairwise(cand.node, chosen.node) < cand.dist) {
        dominated = true;
        break;
      }
    }
    if (dominated) skipped.push(cand);
    else result.push(cand);
  }
  for (const cand of skipped) {
    if (result.length >= m) break;
    result.push(cand);
  }
  return result;
}

/**
 * ANN candidate pre-filter: ef-search from the entry point, returning LIVE
 * candidate chunk indices (tombstones excluded). Mirrors
 * `searchIVFCandidates` — the result feeds the same probed-candidate set.
 */
export function searchHnswCandidates(
  queryVec: Float32Array | Int8Array | number[],
  hnsw: HnswIndex,
  vectors: Array<Float32Array | Int8Array | number[]>,
  options: {
    ef?: number;
    /** Lower-is-closer distance; defaults to cosine distance via `cosine`. */
    distance?: (a: Float32Array | Int8Array | number[], b: number) => number;
  } = {}
): number[] {
  if (hnsw.entryPoint < 0 || hnsw.levels.length === 0) return [];
  const distance =
    options.distance ??
    ((a: Float32Array | Int8Array | number[], b: number) => 1 - dotSimilarity(a, vectors[b]));
  const qDist = (node: number) => distance(queryVec, node);

  let ep = hnsw.entryPoint;
  let epDist = qDist(ep);
  for (let l = hnsw.maxLevel; l > 0; l--) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const nb of hnsw.neighbors[ep][l] ?? []) {
        const d = qDist(nb);
        if (d < epDist) {
          epDist = d;
          ep = nb;
          changed = true;
        }
      }
    }
  }

  const ef = Math.max(options.ef ?? DEFAULT_HNSW_EF, 1);
  const found = searchLayer(hnsw, qDist, ep, epDist, 0, ef);
  return found.map((f) => f.node);
}

/** Dot product that tolerates int8 storage (norm handling mirrors the exact sweep). */
function dotSimilarity(a: Float32Array | Int8Array | number[], b: Float32Array | Int8Array | number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * (b as ArrayLike<number>)[i];
  return s;
}

export function serializeHnsw(hnsw: HnswIndex): SerializedHnsw {
  return {
    format: 'hnsw-v1',
    dim: hnsw.dim,
    M: hnsw.M,
    seed: hnsw.seed,
    entryPoint: hnsw.entryPoint,
    maxLevel: hnsw.maxLevel,
    count: hnsw.levels.length,
    levels: hnsw.levels,
    neighbors: hnsw.neighbors,
    deleted: [...hnsw.deleted].sort((a, b) => a - b),
  };
}

/**
 * Hardened deserialization — every structural invariant is checked with the
 * same discipline as `deserializeIVF`; any violation throws (the loader
 * falls back to brute force).
 */
export function deserializeHnsw(raw: unknown, expectedChunksCount?: number): HnswIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid HNSW payload: expected JSON object — run `mdss index` to rebuild');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== 'hnsw-v1') {
    throw new Error(`invalid HNSW payload: format must be "hnsw-v1", got ${JSON.stringify(obj.format)} — run \`mdss index\` to rebuild`);
  }
  const { dim, M, seed, entryPoint, maxLevel, count } = obj as Record<string, unknown>;
  if (
    typeof dim !== 'number' || !Number.isSafeInteger(dim) || dim <= 0 ||
    typeof M !== 'number' || !Number.isSafeInteger(M) || M <= 0 || M > 128 ||
    typeof seed !== 'number' || !Number.isSafeInteger(seed) ||
    typeof entryPoint !== 'number' || !Number.isSafeInteger(entryPoint) || entryPoint < 0 ||
    typeof maxLevel !== 'number' || !Number.isSafeInteger(maxLevel) || maxLevel < 0 ||
    typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0
  ) {
    throw new Error('invalid HNSW payload: invalid header — run `mdss index` to rebuild');
  }
  if (!Array.isArray(obj.levels) || obj.levels.length !== count) {
    throw new Error(`invalid HNSW payload: levels must be an array of ${count} — run \`mdss index\` to rebuild`);
  }
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const l = (obj.levels as unknown[])[i];
    if (typeof l !== 'number' || !Number.isSafeInteger(l) || l < 0 || l > maxLevel) {
      throw new Error(`invalid HNSW payload: level of node ${i} must be an integer in [0, ${maxLevel}] — run \`mdss index\` to rebuild`);
    }
    levels.push(l);
  }
  if (levels[entryPoint] !== maxLevel) {
    throw new Error(`invalid HNSW payload: entry point ${entryPoint} must sit on the top layer ${maxLevel} — run \`mdss index\` to rebuild`);
  }
  if (!Array.isArray(obj.neighbors) || obj.neighbors.length !== count) {
    throw new Error(`invalid HNSW payload: neighbors must be an array of ${count} — run \`mdss index\` to rebuild`);
  }
  const neighbors: number[][][] = new Array(count);
  const m0 = M * 2;
  for (let i = 0; i < count; i++) {
    const perLevel = (obj.neighbors as unknown[])[i];
    if (!Array.isArray(perLevel) || perLevel.length !== levels[i] + 1) {
      throw new Error(`invalid HNSW payload: node ${i} must have ${levels[i] + 1} link lists — run \`mdss index\` to rebuild`);
    }
    const node: number[][] = new Array(levels[i] + 1);
    for (let l = 0; l <= levels[i]; l++) {
      const list = perLevel[l];
      if (!Array.isArray(list)) {
        throw new Error(`invalid HNSW payload: node ${i} layer ${l} must be an array — run \`mdss index\` to rebuild`);
      }
      if (list.length > (l === 0 ? m0 : M)) {
        throw new Error(`invalid HNSW payload: node ${i} layer ${l} exceeds the link cap — run \`mdss index\` to rebuild`);
      }
      const seen = new Set<number>();
      for (const nb of list) {
        if (typeof nb !== 'number' || !Number.isSafeInteger(nb) || nb < 0 || nb >= count || nb === i) {
          throw new Error(`invalid HNSW payload: node ${i} layer ${l} has invalid link ${JSON.stringify(nb)} — run \`mdss index\` to rebuild`);
        }
        if (seen.has(nb)) {
          throw new Error(`invalid HNSW payload: duplicate link ${nb} on node ${i} layer ${l} — run \`mdss index\` to rebuild`);
        }
        seen.add(nb);
      }
      node[l] = list as number[];
    }
    neighbors[i] = node;
  }
  let deleted = new Set<number>();
  if (obj.deleted !== undefined) {
    if (!Array.isArray(obj.deleted)) {
      throw new Error('invalid HNSW payload: deleted must be an array — run `mdss index` to rebuild');
    }
    for (const idx of obj.deleted) {
      if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0 || idx >= count) {
        throw new Error(`invalid HNSW payload: deleted index ${JSON.stringify(idx)} out of range — run \`mdss index\` to rebuild`);
      }
      deleted.add(idx);
    }
  }
  if (expectedChunksCount !== undefined && count > expectedChunksCount) {
    throw new Error(`invalid HNSW payload: ${count} nodes exceed ${expectedChunksCount} chunks — run \`mdss index\` to rebuild`);
  }
  return { dim, M, seed, entryPoint, maxLevel, levels, neighbors, deleted };
}

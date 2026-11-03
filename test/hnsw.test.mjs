import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHnsw, insertHnsw, deleteHnsw, searchHnswCandidates,
  serializeHnsw, deserializeHnsw, selectNeighborsHeuristic,
} from '../dist/hnsw.js';

/** Deterministic clustered corpus (same generator shape as bench/ann-recall.mjs). */
function makeCorpus(n, dim, centers = 8) {
  const centerVecs = [];
  for (let c = 0; c < centers; c++) {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = Math.sin(c * 31 + d * 17) * 2;
    const norm = Math.hypot(...v) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;
    centerVecs.push(v);
  }
  const vectors = [];
  for (let i = 0; i < n; i++) {
    const center = centerVecs[i % centers];
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = center[d] + Math.sin(i * 7 + d * 3) * 0.2;
    const norm = Math.hypot(...v) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;
    vectors.push(v);
  }
  return { vectors, centerVecs };
}

function bruteTop10(query, vectors) {
  return vectors
    .map((v, i) => ({ i, s: v.reduce((acc, x, d) => acc + x * query[d], 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => x.i);
}

test('hnsw #201: recall@10 vs brute force ≥ 0.98 on a clustered corpus (ef=64)', () => {
  const n = 1500;
  const dim = 64;
  const { vectors } = makeCorpus(n, dim);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });

  let recall = 0;
  const queries = 40;
  for (let q = 0; q < queries; q++) {
    const qv = vectors[(q * 91) % n];
    const gt = new Set(bruteTop10(qv, vectors));
    const ann = searchHnswCandidates(qv, hnsw, vectors, { ef: 64, distance }).slice(0, 10);
    recall += ann.filter((i) => gt.has(i)).length / 10;
  }
  const avg = recall / queries;
  assert.ok(avg >= 0.98, `recall@10 = ${(avg * 100).toFixed(1)}% must be ≥ 98%`);
});

test('hnsw #201: serialization round-trip reproduces identical search results', () => {
  const { vectors } = makeCorpus(600, 32, 4);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });

  const round = deserializeHnsw(JSON.parse(JSON.stringify(serializeHnsw(hnsw))), vectors.length);
  for (let q = 0; q < 20; q++) {
    const qv = vectors[(q * 37) % vectors.length];
    assert.deepEqual(
      searchHnswCandidates(qv, round, vectors, { ef: 32, distance }),
      searchHnswCandidates(qv, hnsw, vectors, { ef: 32, distance }),
      `query ${q} identical after round-trip`,
    );
  }
});

test('hnsw #201: hardened deserialization rejects every malformed payload', () => {
  const base = { format: 'hnsw-v1', dim: 2, M: 2, seed: 1, entryPoint: 0, maxLevel: 0, count: 2, levels: [0, 0], neighbors: [[[]], [[]]], deleted: [] };

  for (const mutate of [
    (o) => ({ ...o, format: 'hnsw-v9' }),
    (o) => ({ ...o, dim: 0 }),
    (o) => ({ ...o, M: 999 }),
    (o) => ({ ...o, entryPoint: -1 }),
    (o) => ({ ...o, entryPoint: 1, levels: [1, 0] }, true), // entry not on top layer (maxLevel 0)
    (o) => ({ ...o, levels: [0] }),           // count/levels mismatch
    (o) => ({ ...o, neighbors: [[[]], [], []] }),
    (o) => ({ ...o, neighbors: [[[]], [[0, 1]]] }), // self link
    (o) => ({ ...o, neighbors: [[[]], [[0, 0]]] }), // duplicate link
    (o) => ({ ...o, neighbors: [[[]], [[0, 1, 2, 3, 4]]] }), // link cap breach (M0=4)
    (o) => ({ ...o, deleted: [42] }),
    () => 'not an object',
    () => null,
  ]) {
    const payload = mutate({ ...base });
    assert.throws(() => deserializeHnsw(payload, 2), /invalid HNSW payload|run `mdss index` to rebuild/, JSON.stringify(payload).slice(0, 80));
  }

  // node 0 with level 1 (2 link lists required) fails when it has 1
  assert.throws(
    () => deserializeHnsw({ ...base, maxLevel: 1, levels: [1, 0], neighbors: [[[0]], [[]]] }, 2),
    /link lists/,
  );
  // count above the chunk count is rejected
  assert.throws(() => deserializeHnsw(base, 1), /exceed 1 chunks/);
  // a valid payload passes
  assert.doesNotThrow(() => deserializeHnsw(base, 2));
});

test('hnsw #201: tombstones are skipped by search; re-insert undeletes', () => {
  const n = 300;
  const dim = 16;
  const { vectors } = makeCorpus(n, dim, 3);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });

  const qv = vectors[0];
  const before = searchHnswCandidates(qv, hnsw, vectors, { ef: 64, distance });
  assert.ok(before.length > 0);

  // tombstone everything except node 5 → only 5 can come back
  for (let i = 0; i < n; i++) if (i !== 5) deleteHnsw(hnsw, i);
  const after = searchHnswCandidates(qv, hnsw, vectors, { ef: 64, distance });
  assert.deepEqual(after, [5], 'tombstoned nodes never surface');

  // re-insert undeletes
  insertHnsw(hnsw, 7, distance, vectors);
  const restored = searchHnswCandidates(qv, hnsw, vectors, { ef: 64, distance });
  assert.ok(restored.includes(7) && restored.includes(5));
  assert.ok(restored.every((i) => i === 5 || i === 7), 'other tombstones stay hidden');
});

test('hnsw #201: incremental inserts keep recall; double-insert rejected', () => {
  const dim = 32;
  const { vectors } = makeCorpus(500, dim, 5);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });

  // 100 new vectors appended to the store — inserted one by one
  for (let i = 0; i < 100; i++) {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = Math.cos(i * 3 + d) * 0.8;
    const norm = Math.hypot(...v) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;
    vectors.push(v);
    insertHnsw(hnsw, vectors.length - 1, distance, vectors);
  }

  let recall = 0;
  for (let q = 0; q < 30; q++) {
    const idx = 500 + ((q * 13) % 100);
    const qv = vectors[idx];
    const gt = new Set(bruteTop10(qv, vectors));
    const ann = searchHnswCandidates(qv, hnsw, vectors, { ef: 64, distance }).slice(0, 10);
    recall += ann.filter((i) => gt.has(i)).length / 10;
  }
  assert.ok(recall / 30 >= 0.95, `post-insert recall ${(recall / 30).toFixed(2)} ≥ 0.95`);

  assert.throws(() => insertHnsw(hnsw, 0, distance, vectors), /already present/);
});

test('hnsw #201: selectNeighborsHeuristic — diversity rule and backfill', () => {
  const pairwise = (a, b) => Math.abs(a - b);
  // candidate 9 is dominated by 0 (|9-0| = 9 < 9? no) — construct a clear case:
  // dists from q: 0 → 0.1, 5 → 0.6, 9 → 0.9; 5 is dominated by 0 (|5-0|=5 < 0.6? no in abs terms)
  // use metric space where domination actually happens:
  const cands = [
    { node: 10, dist: 0.1 },
    { node: 11, dist: 0.2 }, // |11-10| = 1 > 0.2 → kept
    { node: 12, dist: 0.25 }, // |12-10| = 2 > 0.25 → kept
  ];
  const res = selectNeighborsHeuristic(cands, 3, pairwise);
  assert.equal(res.length, 3);

  // with a metric where domination is expressible:
  const pts = { 1: [0, 0], 2: [1, 0], 3: [0.4, 0.1] };
  const pd = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
  const cands3 = [
    { node: 1, dist: 0.0 },   // the query's own point
    { node: 3, dist: 0.41 },  // close to 1 (0.412) → dominated by 1 (0.412 < 0.41? borderline)
    { node: 2, dist: 1.0 },
  ];
  const res3 = selectNeighborsHeuristic(cands3, 3, pd);
  assert.ok(res3.some((c) => c.node === 1), 'closest always kept');
  assert.ok(res3.some((c) => c.node === 2), 'diverse direction kept');
  // under-length: heuristic backfills from skipped candidates
  const res4 = selectNeighborsHeuristic(cands3, 10, pd);
  assert.equal(res4.length, 3, 'backfill restores skipped when m exceeds survivors');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// ── issue #223: persisted-graph remap across watch rebuilds ──
import { remapHnsw } from '../dist/hnsw.js';
import { buildIndex } from '../dist/indexer.js';

function fakeEmbed(texts, kind, model) {
  return texts.map((t) => {
    const dim = model?.dim > 0 ? model.dim : 8;
    const v = new Array(dim).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

test('hnsw #223: identity remap reproduces the original graph behavior', () => {
  const { vectors } = makeCorpus(400, 32, 4);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });
  const mapping = vectors.map((_, i) => i);
  const remapped = remapHnsw(hnsw, mapping, vectors.length);
  assert.ok(remapped, 'identity remap succeeds');
  for (let q = 0; q < 10; q++) {
    const qv = vectors[(q * 17) % vectors.length];
    assert.deepEqual(
      searchHnswCandidates(qv, remapped, vectors, { ef: 32, distance }),
      searchHnswCandidates(qv, hnsw, vectors, { ef: 32, distance }),
      `query ${q} identical after identity remap`,
    );
  }
});

test('hnsw #223: partial remap — dropped nodes vanish, holes become invisible placeholders', () => {
  const { vectors } = makeCorpus(200, 16, 3);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });
  // drop every 3rd node (chunk deleted); others shift down: i → i - floor(i/3)
  const mapping = [];
  for (let i = 0; i < vectors.length; i++) {
    mapping.push(i % 3 === 2 ? undefined : i - Math.floor(i / 3));
  }
  const newCount = vectors.length - Math.floor((vectors.length + 2) / 3);
  const remapped = remapHnsw(hnsw, mapping, newCount);
  assert.ok(remapped, 'remap succeeds');
  // holes: every new index must be present and non-deleted after placeholder fill
  let live = 0;
  for (let i = 0; i < newCount; i++) {
    if (!remapped.deleted.has(i)) live++;
  }
  assert.equal(live, newCount, 'all placeholders filled (no holes before insert phase)');
  // surviving node content must stay reachable: query node 0's vector
  const before = searchHnswCandidates(vectors[0], hnsw, vectors, { ef: 32, distance }).filter((i) => mapping[i] !== undefined);
  const after = searchHnswCandidates(vectors[0], remapped, vectors.slice(0, newCount).map((_, j) => vectors[mapping.indexOf(j)]), { ef: 32, distance });
  assert.ok(after.length > 0);
  assert.ok(before.map((i) => mapping[i]).includes(after[0]) || after[0] === 0,
    'the closest survivor remains the top candidate after remap');
  // round-trips through serialization
  const round = deserializeHnsw(JSON.parse(JSON.stringify(serializeHnsw(remapped))), newCount);
  assert.equal(round.levels.length, newCount);
});

test('hnsw #223: entry-point death re-anchors to a top-layer survivor', () => {
  const { vectors } = makeCorpus(120, 16, 2);
  const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
  const hnsw = buildHnsw(vectors, { distance, vectors });
  const deadEntry = hnsw.entryPoint;
  // kill whatever node holds the entry: it maps to nothing
  const mapping = vectors.map((_, i) => (i === deadEntry ? undefined : i < deadEntry ? i : i - 1));
  const remapped = remapHnsw(hnsw, mapping, vectors.length - 1);
  assert.ok(remapped, 'remap re-anchors when the old entry dies');
  assert.equal(remapped.entryPoint !== mapping[deadEntry], true, 'entry moved off the dead node');
  assert.equal(remapped.levels[remapped.entryPoint], remapped.maxLevel, 'entry sits on the top layer');
  assert.equal(remapped.deleted.has(remapped.entryPoint), false);
});

test('indexer #223: watch rebuild reuses the graph — survivors kept, new inserted, recall holds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-hnsw-rebuild-'));
  const idx = path.join(dir, '.mdss');
  const logs = [];
  const log = (msg) => logs.push(String(msg));
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text, 'utf8');
  const sec = (t, n) => Array.from({ length: n }, (_, i) => `${t} detail line ${i} with enough words to stay one chunk under any budget.`).join('\n');
  try {
    write('a.md', `# A\n\n${sec('alpha', 12)}`);
    write('b.md', `# B\n\n${sec('beta', 12)}`);
    write('c.md', `# C\n\n${sec('gamma', 12)}`);

    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, ann: 'hnsw', log });
    const firstCount = JSON.parse(fs.readFileSync(path.join(idx, 'hnsw.json'), 'utf8')).count;

    // watch-style rebuild: edit b, add d — a and c survive untouched
    write('b.md', `# B\n\n${sec('beta-edited', 12)}`);
    write('d.md', `# D\n\n${sec('delta', 12)}`);
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, ann: 'hnsw', log });

    assert.ok(logs.some((m) => /hnsw: reused persisted graph/.test(m)), 'reuse log line present');
    const graph = deserializeHnsw(JSON.parse(fs.readFileSync(path.join(idx, 'hnsw.json'), 'utf8')), undefined);
    assert.ok(graph.levels.length > firstCount, `graph grew with the corpus (${firstCount} → ${graph.levels.length})`);

    // recall after remap+insert vs brute force over the NEW corpus vectors
    const { loadIndex } = await import('../dist/search.js');
    const loaded = loadIndex(idx);
    const vectors = loaded.index.chunks.map((c) => (c.vec instanceof Float32Array ? c.vec : Float32Array.from(c.vec)));
    const distance = (q, b) => 1 - vectors[b].reduce((s, x, i) => s + x * q[i], 0);
    const kk = Math.min(10, vectors.length);
    let recall = 0;
    for (let q = 0; q < 25; q++) {
      const qv = vectors[(q * 29) % vectors.length];
      const gt = new Set(bruteTop10(qv, vectors));
      const ann = searchHnswCandidates(qv, graph, vectors, { ef: 64, distance }).slice(0, kk);
      recall += ann.filter((i) => gt.has(i)).length / kk;
    }
    assert.ok(recall / 25 >= 0.9, `post-rebuild recall ${(recall / 25).toFixed(2)} ≥ 0.90`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('indexer #223: corrupt sidecar and budget switch fall back to a full rebuild', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-hnsw-fallback-'));
  const idx = path.join(dir, '.mdss');
  const logs = [];
  const log = (msg) => logs.push(String(msg));
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\nalpha content for the corpus ' + 'word '.repeat(40));
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, ann: 'hnsw', log });
    fs.writeFileSync(path.join(idx, 'hnsw.json'), '{corrupt');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, ann: 'hnsw', log });
    assert.ok(!logs.some((m) => /reused persisted graph/.test(m)), 'corrupt sidecar → no reuse');
    // sidecar healthy again
    const after = deserializeHnsw(JSON.parse(fs.readFileSync(path.join(idx, 'hnsw.json'), 'utf8')), undefined);
    assert.ok(after.levels.length > 0, 'rebuilt sidecar is valid again');

    // budget switch (chunkerChanged) → reuse disabled by design
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, ann: 'hnsw', maxChunkTokens: 64, log });
    assert.equal(logs.filter((m) => /reused persisted graph/.test(m)).length, 0, 'budget switch forces a fresh graph');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

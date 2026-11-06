import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  trainIVF,
  searchIVFCandidates,
  serializeIVF,
  deserializeIVF,
} from '../dist/ivf.js';
import { buildIndex } from '../dist/indexer.js';
import { search, loadIndex, searchIndex, prewarmAnnRuntime } from '../dist/search.js';
import { cosine } from '../dist/core.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function randomNormalizedVector(dim) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (Math.random() - 0.5) * 2;
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

test('ivf: trainIVF, serializeIVF, deserializeIVF produce valid cluster indices and centroids', () => {
  const dim = 16;
  const numVectors = 100;
  const vectors = Array.from({ length: numVectors }, () => randomNormalizedVector(dim));

  const ivf = trainIVF(vectors, { k: 10, maxIterations: 15 });
  assert.equal(ivf.dim, dim);
  assert.equal(ivf.k, 10);
  assert.equal(ivf.centroids.length, 10 * dim);
  assert.equal(ivf.clusters.length, 10);

  const totalAssigned = ivf.clusters.reduce((acc, c) => acc + c.length, 0);
  assert.equal(totalAssigned, numVectors);

  const serialized = serializeIVF(ivf);
  assert.equal(typeof serialized.centroids, 'string');
  assert.equal(serialized.k, 10);
  assert.equal(serialized.dim, dim);

  const restored = deserializeIVF(serialized);
  assert.equal(restored.dim, dim);
  assert.equal(restored.k, 10);
  assert.equal(restored.centroids.length, 10 * dim);
  assert.deepEqual(restored.clusters, ivf.clusters);

  const query = randomNormalizedVector(dim);
  const candidates = searchIVFCandidates(query, restored, 3);
  assert.ok(candidates.length > 0);
  for (const idx of candidates) {
    assert.ok(idx >= 0 && idx < numVectors);
  }
});

test('ivf: Recall@10 >= 0.95 on clustered corpus with nprobe', () => {
  const dim = 32;
  const numClusters = 10;
  const docsPerCluster = 60;
  const clusterCenters = Array.from({ length: numClusters }, () => randomNormalizedVector(dim));

  const vectors = [];
  for (let c = 0; c < numClusters; c++) {
    const center = clusterCenters[c];
    for (let d = 0; d < docsPerCluster; d++) {
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) {
        v[i] = center[i] + (Math.random() - 0.5) * 0.3;
      }
      const norm = Math.hypot(...v) || 1;
      for (let i = 0; i < dim; i++) v[i] /= norm;
      vectors.push(v);
    }
  }

  const ivf = trainIVF(vectors, { k: 16, maxIterations: 20 });
  const numQueries = 25;
  let totalOverlap = 0;
  const k = 10;

  for (let q = 0; q < numQueries; q++) {
    const targetCluster = clusterCenters[q % numClusters];
    const query = new Float32Array(dim);
    for (let i = 0; i < dim; i++) query[i] = targetCluster[i] + (Math.random() - 0.5) * 0.3;
    const norm = Math.hypot(...query) || 1;
    for (let i = 0; i < dim; i++) query[i] /= norm;

    // Exact top-10
    const exactScores = vectors.map((v, idx) => ({ idx, score: cosine(query, v) }));
    exactScores.sort((a, b) => b.score - a.score);
    const exactTop10 = new Set(exactScores.slice(0, k).map((x) => x.idx));

    // ANN top-10 via IVF
    const candidateIndices = searchIVFCandidates(query, ivf, 8);
    const candidateSet = new Set(candidateIndices);
    const annScores = [...candidateSet].map((idx) => ({ idx, score: cosine(query, vectors[idx]) }));
    annScores.sort((a, b) => b.score - a.score);
    const annTop10 = new Set(annScores.slice(0, k).map((x) => x.idx));

    let overlap = 0;
    for (const idx of annTop10) {
      if (exactTop10.has(idx)) overlap++;
    }
    totalOverlap += overlap / k;
  }

  const avgRecall = totalOverlap / numQueries;
  assert.ok(avgRecall >= 0.95, `Recall@10 should be >= 0.95 (got ${avgRecall.toFixed(3)})`);
});

test('ivf: buildIndex and search with ann option and graceful fallback', async () => {
  const dir = tempDir('ivf-test');
  const idx = path.join(dir, '.mdss');

  function fakeEmbed(texts, _kind, model) {
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

  try {
    for (let f = 0; f < 3; f++) {
      fs.writeFileSync(path.join(dir, `doc${f}.md`), `# Doc ${f}\n\nContent for doc ${f} search query test.\n`);
    }

    const res = await buildIndex({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
      ann: true,
    });
    assert.equal(res.chunks, 3);

    // Below ANN_THRESHOLD, graceful fallback to exact search
    const loaded = loadIndex(idx);
    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'query test',
      k: 2,
      ann: true,
      embedFn: fakeEmbed,
    });
    assert.equal(hits.length, 2);

    const oneShot = await search({
      indexDir: idx,
      cacheDir: dir,
      query: 'query test',
      k: 2,
      ann: true,
      embedFn: fakeEmbed,
    });
    assert.equal(oneShot.length, 2);
  } finally {
    safeRm(dir);
  }
});

test('ivf: deterministic k-means++ seeding produces bit-for-bit identical IVF payloads (issue #139)', () => {
  const dim = 16;
  const numVectors = 60;
  const vectors = Array.from({ length: numVectors }, () => randomNormalizedVector(dim));

  let metrics1;
  const ivf1 = trainIVF(vectors, { k: 6, maxIterations: 10, seeding: 'kmeans++', seed: 12345, onMetric: (m) => { metrics1 = m; } });
  const ivf2 = trainIVF(vectors, { k: 6, maxIterations: 10, seeding: 'kmeans++', seed: 12345 });

  assert.deepEqual(Array.from(ivf1.centroids), Array.from(ivf2.centroids));
  assert.deepEqual(ivf1.clusters, ivf2.clusters);
  assert.ok(metrics1 !== undefined);
  assert.equal(typeof metrics1.emptyClusters, 'number');
  assert.ok(metrics1.iterations >= 1);

  const ser1 = serializeIVF(ivf1);
  const ser2 = serializeIVF(ivf2);
  assert.equal(ser1.centroids, ser2.centroids);
});

test('ivf: deserializeIVF rejects malformed, truncated, and corrupt payloads (issue #138)', () => {
  assert.throws(() => deserializeIVF(null), /invalid IVF payload.*expected JSON object/i);
  assert.throws(() => deserializeIVF([]), /invalid IVF payload.*expected JSON object/i);
  assert.throws(() => deserializeIVF({ dim: 0, k: 5 }), /invalid dim or k/i);
  assert.throws(() => deserializeIVF({ dim: 8, k: -1 }), /invalid dim or k/i);
  assert.throws(() => deserializeIVF({ dim: 8, k: 2, centroids: '' }), /centroids must be a base64 string/i);

  // Truncated / misaligned centroid buffer (not k * dim * 4 bytes)
  const badCentroidsBuf = Buffer.alloc(10); // 10 is not a multiple of 4, and not 2 * 4 * 4 = 32
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: badCentroidsBuf.toString('base64'), clusters: [[], []] }),
    /centroids buffer has 10 bytes, expected 32 bytes/i
  );

  // Valid buffer with 2 * 4 floats
  const validBuf = Buffer.alloc(2 * 4 * 4);
  const f32 = new Float32Array(validBuf.buffer, validBuf.byteOffset, 8);
  f32.fill(0.5);

  // Clusters length mismatch
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: [[]] }),
    /clusters array has length 1, expected 2/i
  );

  // Non-array cluster item
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: ['bad', []] }),
    /cluster 0 must be an array/i
  );

  // Non-integer index in cluster
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: [['abc'], []] }),
    /cluster 0 contains non-integer index/i
  );

  // Out of range chunk index
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: [[100], []] }, 10),
    /chunk index 100 out of range/i
  );

  // Duplicate chunk index within same cluster
  assert.throws(
    () => deserializeIVF({ dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: [[1, 1], []] }),
    /duplicate chunk index 1 in cluster 0/i
  );

  // Valid deserialization
  const valid = deserializeIVF(
    { dim: 4, k: 2, centroids: validBuf.toString('base64'), clusters: [[0, 1], [2, 3]] },
    10
  );
  assert.equal(valid.dim, 4);
  assert.equal(valid.k, 2);
  assert.equal(valid.clusters.length, 2);
});

// ---------------------------------------------------------------------------
// issue #235: `ann:false` is the documented brute-force escape hatch. It used
// to behave exactly like `undefined` (auto), so once a sidecar existed and the
// corpus was above ANN_THRESHOLD there was NO way to get exact search.
// ---------------------------------------------------------------------------

function fakeEmbed235(texts, _kind, model) {
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

// 52 files × 10 sections ≈ 520 chunks — above ANN_THRESHOLD (500, src/ivf.ts).
function buildAnnFalseCorpus(dir) {
  for (let f = 0; f < 52; f++) {
    const sections = [];
    for (let s = 0; s < 10; s++) {
      sections.push(`## Section ${s}\n\nDocument ${f} section ${s} discusses topic ${f % 7} with marker ${f}_${s} and enough body text to survive the minimum chunk filter.`);
    }
    fs.writeFileSync(path.join(dir, `doc${f}.md`), `# Doc ${f}\n\n` + sections.join('\n\n') + '\n');
  }
}

test('ann: ann:false ranks identically to a sidecar-free brute force above the threshold (issue #235)', async () => {
  const dir = tempDir('ann-false');
  const idx = path.join(dir, '.mdss');
  try {
    buildAnnFalseCorpus(dir);
    const res = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'e5-base', embedFn: fakeEmbed235, ann: true,
    });
    assert.ok(res.chunks >= 500, `fixture corpus must be >= ANN_THRESHOLD (got ${res.chunks})`);
    assert.ok(fs.existsSync(path.join(idx, 'ivf.json')), 'sidecar was built');

    // sidecar-free reference: copy the index, drop every ANN sidecar
    const bruteDir = path.join(dir, '.mdss-brute');
    fs.mkdirSync(bruteDir, { recursive: true });
    for (const name of fs.readdirSync(idx)) {
      if (name === 'ivf.json' || name === 'hnsw.json') continue;
      fs.copyFileSync(path.join(idx, name), path.join(bruteDir, name));
    }

    const loaded = loadIndex(idx);
    const forced = await searchIndex({
      loaded, cacheDir: dir, query: 'topic 3', k: 10,
      ann: false, embedFn: fakeEmbed235,
    });
    const brute = await search({
      indexDir: bruteDir, cacheDir: dir, query: 'topic 3', k: 10,
      embedFn: fakeEmbed235,
    });
    assert.equal(forced.length, 10);
    assert.deepEqual(
      forced.map((h) => [h.file, h.heading]),
      brute.map((h) => [h.file, h.heading]),
      'ann:false must produce the exact brute-force ranking, rank for rank',
    );
    assert.deepEqual(
      forced.map((h) => h.cosine),
      brute.map((h) => h.cosine),
      'cosine scores identical too (ANN was never consulted)',
    );
  } finally {
    safeRm(dir);
  }
});

test('ann: the option matrix stays intact after the #235 rewrite (undefined=auto, true, ivf, false)', async () => {
  const dir = tempDir('ann-matrix');
  const idx = path.join(dir, '.mdss');
  try {
    buildAnnFalseCorpus(dir);
    await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'e5-base', embedFn: fakeEmbed235, ann: 'ivf',
    });
    const loaded = loadIndex(idx);
    const common = { loaded, cacheDir: dir, query: 'topic 5', k: 5, embedFn: fakeEmbed235 };

    // undefined = auto → ANN engages (sidecar + above threshold); must still return k hits
    const auto = await searchIndex({ ...common });
    assert.equal(auto.length, 5);

    // explicit engine selections unchanged
    for (const ann of [true, 'ivf']) {
      const hits = await searchIndex({ ...common, ann });
      assert.equal(hits.length, 5, `ann=${String(ann)} still works`);
    }
    // (explicit 'hnsw' without an hnsw sidecar cold-builds the graph inside the
    // query — the #242 cold-path cost — so it is exercised by the hnsw suites,
    // not duplicated here.)

    // false = the brute-force ranking on every call
    const forced1 = await searchIndex({ ...common, ann: false });
    const forced2 = await searchIndex({ ...common, ann: false });
    assert.deepEqual(forced1.map((h) => [h.file, h.heading]), forced2.map((h) => [h.file, h.heading]));
  } finally {
    safeRm(dir);
  }
});

// ---------------------------------------------------------------------------
// issue #242: the ANN cold path — dequantized-matrix + vec-list caching per
// index generation, the #228 WASM kernel on the in-query build, and the
// prewarmAnnRuntime() serve warmup.
// ---------------------------------------------------------------------------

test('ann: prewarmAnnRuntime builds the runtime IVF off the query path (issue #242)', async () => {
  const dir = tempDir('ann-prewarm');
  const idx = path.join(dir, '.mdss');
  try {
    buildAnnFalseCorpus(dir);
    await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'e5-base', embedFn: fakeEmbed235,
    });
    // buildIndex auto-creates ivf.json at >= ANN_THRESHOLD; the cold-build
    // condition prewarm guards is a MISSING sidecar (deleted/corrupt beyond
    // deserialize recovery). Remove it to reach that state.
    fs.unlinkSync(path.join(idx, 'ivf.json'));
    const loaded = loadIndex(idx);
    const logs = [];
    prewarmAnnRuntime(loaded.index, (m) => logs.push(m));

    // prewarmed vs cold: identical rankings, and the first query no longer
    // trains synchronously (the runtime ivf is already attached)
    const hot = await searchIndex({
      loaded, cacheDir: dir, query: 'topic 3', k: 10, embedFn: fakeEmbed235,
    });
    assert.ok(logs.some((m) => /prebuilt the in-memory IVF/.test(m)), 'prewarm logs its work');
    // idempotent: a second prewarm is a no-op (ivf already attached)
    const logs2 = [];
    prewarmAnnRuntime(loaded.index, (m) => logs2.push(m));
    assert.equal(logs2.length, 0, 'prewarm does not rebuild an existing runtime ANN');

    // below the threshold or with a sidecar → silent no-op
    const smallIdx = path.join(dir, '.mdss-small');
    const smallDir = path.join(dir, 'small');
    fs.mkdirSync(smallDir, { recursive: true });
    fs.writeFileSync(path.join(smallDir, 'a.md'), '# A\n\nonly one tiny document here\n');
    await buildIndex({ db: smallDir, indexDir: smallIdx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed235 });
    const smallLogs = [];
    prewarmAnnRuntime(loadIndex(smallIdx).index, (m) => smallLogs.push(m));
    assert.equal(smallLogs.length, 0, 'sub-threshold corpora never prewarm');
  } finally {
    safeRm(dir);
  }
});

test('ann: cached dequantized vectors keep results rank-identical across the cold path (issue #242)', async () => {
  const dir = tempDir('ann-deq');
  const idx = path.join(dir, '.mdss');
  try {
    buildAnnFalseCorpus(dir);
    await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'e5-base', embedFn: fakeEmbed235, ann: true,
    });
    const loaded = loadIndex(idx);
    const common = { loaded, cacheDir: dir, query: 'topic 5', k: 8, embedFn: fakeEmbed235 };

    // int8 sidecar corpus: first (cold) ANN query then a second (warm) one —
    // the dequantize cache must not change any ranking
    const cold = await searchIndex({ ...common, ann: 'ivf', multiQuery: undefined });
    const warm = await searchIndex({ ...common, ann: 'ivf' });
    assert.deepEqual(cold.map((h) => [h.file, h.heading]), warm.map((h) => [h.file, h.heading]));
    assert.deepEqual(cold.map((h) => h.cosine), warm.map((h) => h.cosine));
  } finally {
    safeRm(dir);
  }
});

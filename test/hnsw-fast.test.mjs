// Issue #228: WASM SIMD dot-batch engine — accuracy, recall, determinism, fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWasmDotEngine } from '../dist/wasm-dot.js';
import { buildHnsw, searchHnswCandidates, serializeHnsw } from '../dist/hnsw.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeMatrix(n, dim, seed = 42, clustered = false) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    const center = clustered ? ((i % 40) / 40) * Math.PI : 0;
    for (let d = 0; d < dim; d++) {
      v[d] = clustered ? Math.sin(center + d * 0.1) * 0.6 + (rng() - 0.5) : rng() - 0.5;
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;
    out.push(v);
  }
  return out;
}

function jsDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

test('wasm-dot: point and batch match the JS reference on every dimension class (issue #228)', () => {
  const engine = createWasmDotEngine([new Float32Array(8)]); // probe availability
  if (!engine) return; // no SIMD in this runtime — the fallback path is covered elsewhere

  for (const dim of [1, 37, 256, 768]) {
    const vectors = makeMatrix(40, dim, dim);
    const e = createWasmDotEngine(vectors);
    assert.ok(e, `engine builds at dim=${dim}`);
    const nodes = [0, 5, 11, 39];
    // batch vs reference
    const dots = e.batch(7, nodes);
    for (let j = 0; j < nodes.length; j++) {
      const ref = jsDot(vectors[7], vectors[nodes[j]]);
      assert.ok(Math.abs(dots[j] - ref) < 1e-4, `batch dim=${dim} node=${nodes[j]}: ${dots[j]} vs ${ref}`);
    }
    // point vs reference AND vs batch (one arithmetic order across the engine)
    const p = e.point(7, 11);
    assert.ok(Math.abs(p - jsDot(vectors[7], vectors[11])) < 1e-4, `point dim=${dim}`);
    assert.equal(p, dots[2], `point and batch share the SIMD accumulation order at dim=${dim}`);
  }
});

test('wasm-dot: rejects ragged or non-float matrices (fallback contract, issue #228)', () => {
  assert.equal(createWasmDotEngine([]), null);
  assert.equal(createWasmDotEngine([new Float32Array(4), new Float32Array(8)]), null, 'ragged dims');
  const ragged = [new Float32Array(4), [0.1, 0.2, 0.3, 0.4]];
  assert.equal(createWasmDotEngine(ragged), null, 'non-Float32Array row');
});

test('buildHnsw engine:auto reaches closure-level recall on a clustered corpus (issue #228)', () => {
  const vectors = makeMatrix(600, 64, 3, true);
  const dist = (a, b) => 1 - jsDot(a, vectors[b]);
  const closure = buildHnsw(vectors, { vectors, distance: dist });
  const auto = buildHnsw(vectors, { vectors, distance: dist, engine: 'auto' });

  const queries = makeMatrix(20, 64, 99);
  const recall = (hnsw) => {
    let hits = 0;
    for (const q of queries) {
      const gt = new Set(
        vectors.map((v, i) => ({ i, s: jsDot(q, v) })).sort((x, y) => y.s - x.s).slice(0, 10).map((x) => x.i),
      );
      const cands = searchHnswCandidates(q, hnsw, vectors, { ef: 64 });
      const top = cands.map((i) => ({ i, s: jsDot(q, vectors[i]) })).sort((x, y) => y.s - x.s).slice(0, 10).map((x) => x.i);
      hits += top.filter((i) => gt.has(i)).length / 10;
    }
    return hits / queries.length;
  };
  const rAuto = recall(auto);
  assert.ok(rAuto >= 0.95, `auto recall@10 ${(rAuto * 100).toFixed(1)}% must be ≥ 95%`);
  const rClosure = recall(closure);
  assert.ok(rAuto >= rClosure - 0.05, `auto ${(rAuto * 100).toFixed(1)}% within 5pp of closure ${(rClosure * 100).toFixed(1)}%`);
});

test('buildHnsw engine:auto is deterministic — byte-identical sidecar on rebuild (issue #228)', () => {
  const vectors = makeMatrix(400, 64, 11, true);
  const dist = (a, b) => 1 - jsDot(a, vectors[b]);
  const a1 = JSON.stringify(serializeHnsw(buildHnsw(vectors, { vectors, distance: dist, engine: 'auto' })));
  const a2 = JSON.stringify(serializeHnsw(buildHnsw(vectors, { vectors, distance: dist, engine: 'auto' })));
  assert.equal(a1, a2, 'same engine + same corpus → byte-identical hnsw.json');
});

test('buildHnsw engine:auto silently falls back to closure semantics on non-float vectors (issue #228)', () => {
  // number[] rows (e.g. int8-adjacent code paths) must still build correctly.
  const vectors = makeMatrix(300, 32, 5, true).map((v) => Array.from(v));
  const dist = (a, b) => 1 - jsDot(a, vectors[b]);
  const auto = buildHnsw(vectors, { vectors, distance: dist, engine: 'auto' });
  const closure = buildHnsw(vectors, { vectors, distance: dist });
  assert.equal(auto.levels.length, closure.levels.length);
  assert.equal(JSON.stringify(serializeHnsw(auto)), JSON.stringify(serializeHnsw(closure)),
    'fallback path is bit-identical to the closure path');
});

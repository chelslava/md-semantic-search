// RESEARCH §13 sweep-kernel prototype (issue #259): correctness of the
// 'js-flat' and 'wasm' dense-sweep candidates vs the shipped per-chunk path,
// determinism per engine, and the flag plumbing through searchIndex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectFlatCorpus,
  createWasmSweepEngine,
  resolveSweepKernel,
  sweepFp32Flat,
  sweepInt8Flat,
} from '../dist/sweep-kernel.js';
import { quantizeToInt8, int8Norm, asymmetricCosineInt8CachedNorm } from '../dist/quantization.js';
import { cosine } from '../dist/core.js';
import { buildIndex, loadIndex, searchIndex } from '../dist/index.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/** Deterministic PRNG (Mulberry32) — same shape as the bench corpus generators. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return t;
  };
}

function randomNormalizedVector(dim, rand) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (rand() - 0.5) * 2;
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

test('sweep-kernel: resolveSweepKernel validates the mode values', () => {
  assert.equal(resolveSweepKernel(undefined), 'js');
  assert.equal(resolveSweepKernel(null), 'js');
  assert.equal(resolveSweepKernel(''), 'js');
  assert.equal(resolveSweepKernel('js'), 'js');
  assert.equal(resolveSweepKernel('js-flat'), 'js-flat');
  assert.equal(resolveSweepKernel('wasm'), 'wasm');
  assert.throws(() => resolveSweepKernel('simd'), /invalid sweep kernel mode/);
  assert.throws(() => resolveSweepKernel(42), /invalid sweep kernel mode/);
});

test('sweep-kernel: collectFlatCorpus — zero-copy view for contiguous views, per-row copy otherwise', () => {
  const dim = 16;
  const count = 4;
  // contiguous views over one buffer (the binary-format load path)
  const buf = new Int8Array(count * dim);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 128 - 64;
  const chunks = Array.from({ length: count }, (_, i) => ({ vec: buf.subarray(i * dim, (i + 1) * dim) }));
  const flat = collectFlatCorpus(chunks);
  assert.ok(flat && flat.i8);
  assert.equal(flat.i8.length, count * dim);
  assert.equal(flat.i8.buffer, buf.buffer); // zero-copy view

  // separate arrays (the legacy vectors.json load path) — copies
  const separate = Array.from({ length: count }, (_, i) => ({ vec: buf.slice(i * dim, (i + 1) * dim) }));
  const flat2 = collectFlatCorpus(separate);
  assert.ok(flat2 && flat2.i8);
  assert.deepEqual([...flat2.i8], [...buf]);
  assert.notEqual(flat2.i8.buffer, buf.buffer);

  // ragged corpus → null
  const ragged = [...separate.slice(0, 3), { vec: new Int8Array(dim + 1) }];
  assert.equal(collectFlatCorpus(ragged), null);
  assert.equal(collectFlatCorpus([]), null);
});

test('sweep-kernel: js-flat int8 sweep matches the shipped per-chunk path (same accumulation order)', () => {
  const rand = mulberry32(259);
  for (const dim of [8, 16, 384, 768]) {
    const count = 17;
    const rows = Array.from({ length: count }, () => quantizeToInt8(randomNormalizedVector(dim, rand)));
    const flat = new Int8Array(count * dim);
    rows.forEach((r, i) => flat.set(r, i * dim));
    const norms = Float32Array.from(rows, (r) => int8Norm(r));
    const q = randomNormalizedVector(dim, rand);
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    const out = new Float32Array(count);
    sweepInt8Flat(q, flat, indices, out, norms, dim);
    for (let j = 0; j < count; j++) {
      const expected = asymmetricCosineInt8CachedNorm(q, rows[indices[j]], norms[indices[j]]);
      // same accumulation order as the shipped loop — equal within the last
      // f32 ulp (V8 may contract mul+add into FMA differently per function)
      assert.ok(
        Math.abs(out[j] - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
        `dim ${dim} row ${j}: js-flat ${out[j]} vs shipped ${expected}`
      );
    }
    // zero-norm rows score 0 (mirrors the !(norm > 0) guard)
    const zeroRow = new Int8Array(dim);
    flat.set(zeroRow, 0);
    norms[0] = 0;
    sweepInt8Flat(q, flat, indices, out, norms, dim);
    assert.equal(out[0], 0);
  }
});

test('sweep-kernel: js-flat fp32 sweep matches core.cosine (same accumulation order)', () => {
  const rand = mulberry32(260);
  for (const dim of [8, 16, 384, 768]) {
    const count = 13;
    const flat = new Float32Array(count * dim);
    for (let i = 0; i < flat.length; i++) flat[i] = (rand() - 0.5) * 2;
    const q = randomNormalizedVector(dim, rand);
    const indices = Uint32Array.from({ length: count }, (_, i) => (i * 5 + 2) % count);
    const out = new Float32Array(count);
    sweepFp32Flat(q, flat, indices, out, dim);
    for (let j = 0; j < count; j++) {
      const expected = cosine(q, flat.subarray(indices[j] * dim, (indices[j] + 1) * dim));
      assert.ok(
        Math.abs(out[j] - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
        `dim ${dim} row ${j}: js-flat ${out[j]} vs cosine ${expected}`
      );
    }
  }
});

test('sweep-kernel: wasm engine matches the shipped path within f32 tolerance (both formats)', () => {
  const rand = mulberry32(261);
  for (const dim of [16, 384, 768]) {
    // int8: scores within a few ulp of the cached-norm path (same f32 class)
    const count = 64;
    const rows = Array.from({ length: count }, () => quantizeToInt8(randomNormalizedVector(dim, rand)));
    const flat = new Int8Array(count * dim);
    rows.forEach((r, i) => flat.set(r, i * dim));
    const norms = Float32Array.from(rows, (r) => int8Norm(r));
    const q = randomNormalizedVector(dim, rand);
    const engine = createWasmSweepEngine(flat, norms, dim, count);
    assert.ok(engine, 'wasm engine must build in a SIMD-capable runtime');
    assert.equal(engine.format, 'int8');
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    const out = new Float32Array(count);
    engine.sweep(q, indices, out);
    for (let j = 0; j < count; j++) {
      const expected = asymmetricCosineInt8CachedNorm(q, rows[j], norms[j]);
      const scale = Math.max(1, Math.abs(expected));
      assert.ok(
        Math.abs(out[j] - expected) <= 1e-5 * scale,
        `dim ${dim} int8 row ${j}: wasm ${out[j]} vs js ${expected}`
      );
    }
    // determinism: same inputs → identical scores
    const out2 = new Float32Array(count);
    engine.sweep(q, indices, out2);
    assert.deepEqual([...out2], [...out]);

    // fp32: dot against the flat corpus
    const fflat = new Float32Array(count * dim);
    for (let i = 0; i < fflat.length; i++) fflat[i] = (rand() - 0.5) * 2;
    const fengine = createWasmSweepEngine(fflat, null, dim, count);
    assert.ok(fengine);
    assert.equal(fengine.format, 'fp32');
    const fout = new Float32Array(count);
    fengine.sweep(q, indices, fout);
    for (let j = 0; j < count; j++) {
      // fp32 rows use the dot path in the shipped sweep: cosine(q, row)
      const expectedDot = cosine(q, fflat.subarray(indices[j] * dim, (indices[j] + 1) * dim));
      const scale = Math.max(1, Math.abs(expectedDot));
      assert.ok(
        Math.abs(fout[j] - expectedDot) <= 1e-5 * scale,
        `dim ${dim} fp32 row ${j}: wasm ${fout[j]} vs js ${expectedDot}`
      );
    }
  }
});

test('sweep-kernel: wasm engine degrades to null on bad geometry, non-float query sweep is a no-op', () => {
  const dim = 8;
  const corpus = new Int8Array(4 * dim);
  const norms = new Float32Array(4).fill(1);
  assert.equal(createWasmSweepEngine(corpus, norms, 0, 4), null);
  assert.equal(createWasmSweepEngine(corpus, norms, dim, 0), null);
  assert.equal(createWasmSweepEngine(corpus, norms, dim, 5), null); // corpus too small
  assert.equal(createWasmSweepEngine(corpus, null, dim, 4), null); // int8 needs norms
  const engine = createWasmSweepEngine(corpus, norms, dim, 4);
  assert.ok(engine);
  const out = new Float32Array(4);
  engine.sweep(new Float32Array(dim + 1), new Uint32Array([0, 1, 2, 3]), out); // dim mismatch → no-op
  assert.deepEqual([...out], [0, 0, 0, 0]);
  assert.throws(() => engine.sweep(new Float32Array(dim), new Uint32Array([4]), out), /row index out of range/);
});

test('sweep-kernel: searchIndex plumbing — wasm is the default sweep path, js is the escape hatch', async () => {
  const dir = tempDir('sweep-kernel');
  try {
    // 8 deterministic markdown files, 12 sections each (~96 chunks)
    const sectionsPerFile = 12;
    const topics = ['deploy', 'network', 'storage', 'auth', 'billing', 'observability'];
    for (let f = 0; f < 8; f++) {
      const sections = [];
      for (let s = 0; s < sectionsPerFile; s++) {
        const topic = topics[(f + s) % topics.length];
        sections.push(`## Section ${s} — ${topic}\n\nDocument ${f} section ${s} covers ${topic} runbook steps with marker ${f}_${s} and body text.`);
      }
      fs.writeFileSync(path.join(dir, `doc${f}.md`), `# Doc ${f}\n\n` + sections.join('\n\n') + '\n');
    }
    const idxDir = path.join(dir, '.mdss');
    await buildIndex({
      db: dir,
      indexDir: idxDir,
      cacheDir: path.join(dir, '.cache'),
      modelName: 'e5-base',
      embedFn: (texts, _kind, model) =>
        texts.map((t) => {
          const dim = model?.dim > 0 ? model.dim : 384;
          const v = new Float32Array(dim);
          for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
            let h = 7;
            for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
            v[h % dim] += 1;
          }
          const norm = Math.hypot(...v) || 1;
          return v.map((x) => x / norm);
        }),
      quantize: 'int8',
      offline: true,
    });
    const loaded = loadIndex(idxDir);
    const queries = ['runbook steps for topic deploy marker 3_5', 'storage runbook marker 7_2', 'auth steps topic 4 marker 1_9'];
    const hashEmbed = (texts, _kind, model) =>
      texts.map((t) => {
        const dim = model?.dim > 0 ? model.dim : 384;
        const v = new Float32Array(dim);
        for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
          let h = 7;
          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
          v[h % dim] += 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });

    const run = (mode, extra = {}) =>
      Promise.all(
        queries.map((q) =>
          searchIndex({ loaded, cacheDir: path.join(dir, '.cache'), query: q, k: 6, embedFn: hashEmbed, offline: true, ann: false, ...(mode !== undefined ? { sweepKernel: mode } : {}), ...extra })
        )
      );

    const js = await run('js');
    const jsFlat = await run('js-flat');
    const wasm = await run('wasm');
    const byDefault = await run(undefined); // no option → 'wasm' is the default path
    // escape hatch via env: legacy last-ulp-exact scores
    process.env.MDSS_SWEEP_KERNEL = 'js';
    let jsEnv;
    try {
      jsEnv = await run(undefined);
    } finally {
      delete process.env.MDSS_SWEEP_KERNEL;
    }

    const hitKeys = (hits) => hits.map((h) => `${h.file}#${h.heading}`);
    assert.deepEqual(hitKeys(byDefault), hitKeys(wasm), "the default sweep path is 'wasm'");
    assert.deepEqual(hitKeys(jsEnv), hitKeys(js), 'MDSS_SWEEP_KERNEL=js drives the legacy path');
    assert.deepEqual(hitKeys(jsFlat), hitKeys(js), 'js-flat matches the js hit list on this corpus');
    assert.deepEqual(hitKeys(wasm), hitKeys(js), 'wasm last-ulp differences must not move the top-6 on this corpus');
    for (let q = 0; q < queries.length; q++) {
      for (let h = 0; h < js[q].length; h++) {
        assert.ok(Math.abs(wasm[q][h].cosine - js[q][h].cosine) <= 1e-5 * Math.max(1, Math.abs(js[q][h].cosine)));
      }
    }
  } finally {
    safeRm(dir);
  }
});

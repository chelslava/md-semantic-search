import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  quantizeToInt8,
  dequantizeFromInt8,
  asymmetricCosineInt8,
  asymmetricCosineInt8CachedNorm,
  int8Norm,
  INT8_SCALE,
} from '../dist/quantization.js';
import { cosine } from '../dist/core.js';
import { serializeBinaryIndex, deserializeBinaryIndex } from '../dist/binary-format.js';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex, getRuntimeChunkNorms } from '../dist/search.js';

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

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('quantization: quantizeToInt8 and dequantizeFromInt8 roundtrip has bounded error <= 1/127', () => {
  const dim = 768;
  const raw = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    raw[i] = Math.sin(i * 0.1);
  }
  // Normalize
  const norm = Math.hypot(...raw);
  for (let i = 0; i < dim; i++) raw[i] /= norm;

  const q = quantizeToInt8(raw);
  assert.equal(q instanceof Int8Array, true);
  assert.equal(q.length, dim);

  const deq = dequantizeFromInt8(q);
  assert.equal(deq instanceof Float32Array, true);
  assert.equal(deq.length, dim);

  for (let i = 0; i < dim; i++) {
    const err = Math.abs(raw[i] - deq[i]);
    assert.ok(err <= 1.0 / INT8_SCALE + 1e-6, `error ${err} at index ${i} is within 1/127 threshold`);
  }
});

test('quantization: asymmetricCosineInt8 matches float32 cosine with high precision (diff < 0.015)', () => {
  const dim = 768;
  const q = new Float32Array(dim);
  const c = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    q[i] = Math.cos(i * 0.05);
    c[i] = Math.sin(i * 0.05 + 0.3);
  }
  const qNorm = Math.hypot(...q);
  const cNorm = Math.hypot(...c);
  for (let i = 0; i < dim; i++) {
    q[i] /= qNorm;
    c[i] /= cNorm;
  }

  const cInt8 = quantizeToInt8(c);
  const floatSim = cosine(q, c);
  const int8Sim = asymmetricCosineInt8(q, cInt8);

  const diff = Math.abs(floatSim - int8Sim);
  assert.ok(diff < 0.015, `cosine difference ${diff} between fp32 and int8 is small (< 0.015)`);
  assert.ok(Math.abs(cosine(q, cInt8) - int8Sim) < 1e-6, 'core.cosine handles Int8Array automatically');
});

test('quantization: serializeBinaryIndex with quantize: "int8" produces 4x smaller vector payload', () => {
  const index = {
    schemaVersion: 4,
    format: 'binary-v1',
    model: 'Xenova/multilingual-e5-base',
    dim: 768,
    db: '/test',
    built: '2026-08-18',
    complete: true,
    chunkCount: 10,
    chunks: Array.from({ length: 10 }, (_, i) => ({
      file: `doc${i}.md`,
      title: `Doc ${i}`,
      heading: 'Intro',
      headingPath: [`Doc ${i}`, 'Intro'],
      text: `Content of doc ${i}`,
      chunkHash: `hash${i}`,
      vec: Array.from({ length: 768 }, (_, j) => Math.sin(i + j)),
    })),
  };

  const fp32Buf = serializeBinaryIndex(index, 768, { quantize: 'fp32' });
  const int8Buf = serializeBinaryIndex(index, 768, { quantize: 'int8' });

  // Vectors bytes: 10 * 768 * 4 = 30720 for fp32, vs 10 * 768 * 1 = 7680 for int8
  const fp32VectorsSize = 10 * 768 * 4;
  const int8VectorsSize = 10 * 768 * 1;
  assert.ok(fp32Buf.length - int8Buf.length === fp32VectorsSize - int8VectorsSize);

  const loadedInt8 = deserializeBinaryIndex(int8Buf);
  assert.equal(loadedInt8.quantized, 'int8');
  assert.ok(loadedInt8.rawVectorsBuffer instanceof Int8Array);
  assert.equal(loadedInt8.rawVectorsBuffer.length, 10 * 768);
});

test('quantization: buildIndex and search with quantize: "int8" operates accurately end-to-end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-int8-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Microservices Architecture\n\n## Backend\n\nkubernetes docker distributed caching\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Frontend Frameworks\n\n## Client\n\nreact components state dom virtual\n');

    await buildIndex({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
      quantize: 'int8',
    });

    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, 2);

    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'microservices architecture caching',
      k: 2,
      embedFn: fakeEmbed,
    });

    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, 'a.md');
  } finally {
    safeRm(dir);
  }
});

test('quantization: cached-norm fast path is bitwise-equivalent to the combined sweep (issue #190)', () => {
  const dim = 768;
  for (let trial = 0; trial < 5; trial++) {
    const q = new Float32Array(dim);
    const c = new Float32Array(dim);
    let seed = trial * 7919 + 13;
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      q[i] = ((seed % 2000) - 1000) / 1000;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      c[i] = ((seed % 2000) - 1000) / 1000;
    }
    const cInt8 = quantizeToInt8(c);
    const legacy = asymmetricCosineInt8(q, cInt8);
    const fast = asymmetricCosineInt8CachedNorm(q, cInt8, int8Norm(cInt8));
    assert.ok(
      Math.abs(legacy - fast) < 1e-9,
      `trial ${trial}: legacy ${legacy} vs cached-norm ${fast}`
    );
  }
  // zero vector scores 0 in both paths
  const zero = new Int8Array(dim);
  const anyQ = new Float32Array(dim).fill(0.5);
  assert.equal(asymmetricCosineInt8CachedNorm(anyQ, zero, int8Norm(zero)), 0.0);
});

test('quantization: binary-loaded index populates chunkNorms and search matches the json load (issue #190)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-norms-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'coffee.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground brew\n');
    fs.writeFileSync(path.join(dir, 'travel.md'), '# Travel Plans\n\n## Japan\n\ntokyo kyoto bullet train travel guide itinerary\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed, quantize: 'int8' });

    // the bin must be strictly newer than vectors.json (#187 tie-break)
    const jsonMtime = fs.statSync(path.join(idx, 'vectors.json')).mtimeMs;
    const binPath = path.join(idx, 'vectors.bin');
    if (fs.statSync(binPath).mtimeMs <= jsonMtime) {
      const t = jsonMtime + 2;
      fs.utimesSync(binPath, new Date(t), new Date(t));
    }

    // binary load path carries the zero-copy int8 buffer -> norms populated
    const binLoaded = loadIndex(idx);
    const norms = getRuntimeChunkNorms(binLoaded.index);
    assert.ok(norms instanceof Float32Array, 'chunk norms cached at load');
    assert.equal(norms.length, binLoaded.index.chunks.length);

    const binHits = await searchIndex({ loaded: binLoaded, cacheDir: dir, query: 'coffee brewing', k: 3, embedFn: fakeEmbed });
    assert.ok(binHits.length >= 1);
    assert.equal(binHits[0].file, 'coffee.md');

    // json-only load (bin hidden -> loadIndex takes the JSON path) returns the
    // same ranking; JSON keeps no cached norms (Float32 runtime, no int8 buffer)
    const binFile = path.join(idx, 'vectors.bin');
    const binHidden = `${binFile}.hidden`;
    fs.renameSync(binFile, binHidden);
    const jsonLoaded = loadIndex(idx);
    fs.renameSync(binHidden, binFile);
    const jsonOnly = { index: jsonLoaded.index, model: jsonLoaded.model };
    assert.equal(getRuntimeChunkNorms(jsonOnly.index), undefined, 'no norms without the int8 buffer');
    const jsonHits = await searchIndex({ loaded: jsonOnly, cacheDir: dir, query: 'coffee brewing', k: 3, embedFn: fakeEmbed });
    assert.deepEqual(
      jsonHits.map((h) => [h.file, h.heading]),
      binHits.map((h) => [h.file, h.heading]),
      'fast path ranking matches the combined path'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

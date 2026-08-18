import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  serializeBinaryIndex,
  deserializeBinaryIndex,
  readBinaryHeader,
  BINARY_HEADER_SIZE,
} from '../dist/binary-format.js';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex } from '../dist/search.js';

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

test('binary-format: serialize and deserialize roundtrip preserves header, vectors, and metadata', () => {
  const index = {
    schemaVersion: 4,
    format: 'binary-v1',
    model: 'Xenova/multilingual-e5-base',
    dim: 4,
    db: '/path/to/docs',
    built: '2026-08-18T10:00:00.000Z',
    complete: true,
    chunkCount: 2,
    lexical: {
      version: 2,
      fieldWeights: { title: 3, aliases: 3, headingPath: 1.8, body: 1 },
      avgDocLength: 10,
      docCount: 2,
      documentLengths: [10, 10],
      postings: {
        guide: [[0, 1], [1, 2]],
      },
    },
    lexicalFormat: 'bm25-v2',
    chunks: [
      {
        file: 'doc1.md',
        title: 'Guide 1',
        heading: 'Intro',
        headingPath: ['Guide 1', 'Intro'],
        text: 'This is the first guide about authentication.',
        chunkHash: 'hash1',
        vec: [0.1, 0.2, 0.3, 0.4],
        meta: { tags: ['auth'], aliases: [], custom: {} },
      },
      {
        file: 'doc2.md',
        title: 'Guide 2',
        heading: 'Setup',
        headingPath: ['Guide 2', 'Setup'],
        text: 'This is the second guide about deployment.',
        chunkHash: 'hash2',
        vec: [0.5, 0.6, 0.7, 0.8],
        meta: { tags: ['deploy'], aliases: [], custom: {} },
      },
    ],
  };

  const buffer = serializeBinaryIndex(index, 4);
  assert.ok(buffer.length > BINARY_HEADER_SIZE);

  const header = readBinaryHeader(buffer);
  assert.equal(header.dim, 4);
  assert.equal(header.chunkCount, 2);
  assert.equal(header.flags, 0);

  const loaded = deserializeBinaryIndex(buffer);
  assert.equal(loaded.dim, 4);
  assert.equal(loaded.chunks.length, 2);
  assert.equal(loaded.chunks[0].file, 'doc1.md');
  assert.equal(loaded.chunks[0].meta?.tags[0], 'auth');

  // Verify raw contiguous Float32Array
  assert.ok(loaded.rawVectorsBuffer instanceof Float32Array);
  assert.equal(loaded.rawVectorsBuffer.length, 8);
  assert.ok(Math.abs(loaded.rawVectorsBuffer[0] - 0.1) < 1e-5);
  assert.ok(Math.abs(loaded.rawVectorsBuffer[4] - 0.5) < 1e-5);
});

test('binary-format: readBinaryHeader rejects invalid magic or short buffers', () => {
  assert.throws(() => readBinaryHeader(Buffer.alloc(10)), /file too small/i);
  const badMagic = Buffer.alloc(64);
  badMagic.write('BADMAGIC', 0, 8, 'ascii');
  assert.throws(() => readBinaryHeader(badMagic), /invalid binary index magic/i);
});

test('buildIndex & loadIndex: automatically creates and loads vectors.bin with zero-copy snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-bin-idx-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee beans roasted ground extraction\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Tea Guide\n\n## Steeping\n\ntea leaves green herbal infusion\n');

    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const binPath = path.join(idx, 'vectors.bin');
    const binShaPath = path.join(idx, 'vectors.bin.sha256');
    assert.ok(fs.existsSync(binPath), 'vectors.bin exists');
    assert.ok(fs.existsSync(binShaPath), 'vectors.bin.sha256 exists');

    // Loading from index directory uses vectors.bin
    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, 2);

    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'coffee beans',
      k: 2,
      embedFn: fakeEmbed,
    });

    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, 'a.md');

    // Remove vectors.bin -> should fall back gracefully to vectors.json
    fs.unlinkSync(binPath);
    const fallbackLoaded = loadIndex(idx);
    assert.equal(fallbackLoaded.index.chunks.length, 2);
    const fallbackHits = await searchIndex({
      loaded: fallbackLoaded,
      cacheDir: dir,
      query: 'coffee beans',
      k: 2,
      embedFn: fakeEmbed,
    });
    assert.equal(fallbackHits[0].file, 'a.md');
  } finally {
    safeRm(dir);
  }
});

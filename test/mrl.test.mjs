import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveModel,
  embeddingAdapterFingerprint,
  truncateAndNormalizeVector,
  buildIndex,
  searchIndex,
  loadIndex,
} from '../dist/index.js';
import { parseArgs } from '../bin/cli.mjs';

test('resolveModel: selects valid MRL dimensions for models with dimensions array', () => {
  const qwenFull = resolveModel('qwen3-embedding-0.6b');
  assert.equal(qwenFull.dim, 1024);
  assert.equal(qwenFull.nativeDim, 1024);
  assert.deepEqual(qwenFull.dimensions, [32, 64, 128, 256, 512, 768, 1024]);

  const qwen256 = resolveModel('qwen3-embedding-0.6b', 256);
  assert.equal(qwen256.dim, 256);
  assert.equal(qwen256.nativeDim, 1024);

  const bge512 = resolveModel('bge-m3', 512);
  assert.equal(bge512.dim, 512);
  assert.equal(bge512.nativeDim, 1024);
});

test('resolveModel: rejects unsupported dimensions or models without MRL support', () => {
  assert.throws(
    () => resolveModel('e5-base', 256),
    /does not declare Matryoshka\/MRL dimensions support/i
  );

  assert.throws(
    () => resolveModel('qwen3-embedding-0.6b', 123),
    /invalid dimension 123 for model.*supported MRL dimensions: 32, 64, 128, 256, 512, 768, 1024/i
  );

  assert.throws(
    () => resolveModel('qwen3-embedding-0.6b', -5),
    /--dimensions must be a positive integer/i
  );
});

test('embeddingAdapterFingerprint: dimension change invalidates fingerprint (forces re-embed)', () => {
  const qwen1024 = resolveModel('qwen3-embedding-0.6b', 1024);
  const qwen256 = resolveModel('qwen3-embedding-0.6b', 256);

  const fp1024 = embeddingAdapterFingerprint(qwen1024);
  const fp256 = embeddingAdapterFingerprint(qwen256);

  assert.notEqual(fp1024, fp256, 'Fingerprints must differ across dimensions');
});

test('truncateAndNormalizeVector: truncates and re-normalizes to unit L2 norm', () => {
  const vec = [1, 2, 3, 4, 5, 6, 7, 8];
  const truncated = truncateAndNormalizeVector(vec, 4, true);
  assert.equal(truncated.length, 4);

  // Check L2 norm is ~1.0
  const l2 = Math.sqrt(truncated.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(l2 - 1.0) < 1e-6, `Expected unit norm, got ${l2}`);

  // Without normalization
  const rawTruncated = truncateAndNormalizeVector(vec, 3, false);
  assert.deepEqual(rawTruncated, [1, 2, 3]);
});

test('buildIndex & searchIndex: end-to-end MRL index building and search verification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mrl-test-'));
  const indexDir = path.join(root, '.mdss');
  const cacheDir = path.join(root, '.cache');
  try {
    fs.writeFileSync(path.join(root, 'auth.md'), '# Authentication\nWe use JWT tokens and OAuth2.\n');
    fs.writeFileSync(path.join(root, 'db.md'), '# Database\nPostgreSQL is our primary store.\n');

    // Mock embedding function returning 1024-dim vectors
    const mockEmbedFn = async (texts, kind, model) => {
      return texts.map((t, idx) => {
        const full = new Array(1024).fill(0).map((_, i) => Math.sin(i + idx + (t.includes('JWT') ? 1 : 10)));
        if (model.dim && model.dim < 1024) {
          return truncateAndNormalizeVector(full, model.dim, true);
        }
        return full;
      });
    };

    // 1. Build index with --dimensions 256
    const res = await buildIndex({
      db: root,
      indexDir,
      cacheDir,
      modelName: 'qwen3-embedding-0.6b',
      dimensions: 256,
      embedFn: mockEmbedFn,
    });

    assert.equal(res.dim, 256);
    assert.equal(res.embedded, 2);

    const loaded = loadIndex(indexDir);
    assert.equal(loaded.index.dim, 256);
    assert.equal(loaded.model.dim, 256);

    // 2. Search index
    const hits = await searchIndex({
      loaded,
      cacheDir,
      query: 'JWT tokens authentication',
      embedFn: mockEmbedFn,
      dimensions: 256,
    });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, 'auth.md');

    // 3. Search with mismatched dimension should throw actionable error
    await assert.rejects(
      async () => {
        await searchIndex({
          loaded,
          cacheDir,
          query: 'JWT tokens',
          embedFn: mockEmbedFn,
          dimensions: 512,
        });
      },
      /requested search dimensions \(512\) does not match index dimension \(256\)/
    );

    // 4. Rebuilding with different dimension (512) triggers full re-embed (0 reused)
    const res512 = await buildIndex({
      db: root,
      indexDir,
      cacheDir,
      modelName: 'qwen3-embedding-0.6b',
      dimensions: 512,
      embedFn: mockEmbedFn,
    });
    assert.equal(res512.dim, 512);
    assert.equal(res512.reusedChunks, 0, 'Changing dimensions must trigger re-embed of chunks');
    assert.equal(res512.embedded, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cli parseArgs: handles --dimensions and --dim flags', () => {
  const o1 = parseArgs(['index', '--db', './docs', '--model', 'qwen3-embedding-0.6b', '--dimensions', '256']);
  assert.equal(o1.dimensions, 256);

  const o2 = parseArgs(['search', '--db', './docs', '--dim', '512', 'some query']);
  assert.equal(o2.dimensions, 512);
});

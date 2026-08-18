import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIndex, searchIndex } from '../dist/search.js';
import { encodeVec } from '../dist/core.js';

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

const DIM = 768;
function makeVec() {
  const v = new Array(DIM).fill(0.01);
  v[0] = 0.5;
  return v;
}

function fakeEmbed(texts) {
  return texts.map(() => makeVec());
}

test('schema-lts: legacy v0 index (no schemaVersion, decimal vectors) loads and is searchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-lts-v0-'));
  try {
    const v0Index = {
      model: 'e5-base',
      dim: DIM,
      chunks: [
        {
          file: 'test.md',
          title: 'Test Document',
          heading: 'Overview',
          text: 'Architecture overview of the system',
          vec: makeVec(),
        },
      ],
    };

    fs.writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(v0Index));
    const loaded = loadIndex(dir);
    assert.equal(loaded.index.chunks.length, 1);

    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'architecture',
      embedFn: fakeEmbed,
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'test.md');
  } finally {
    safeRm(dir);
  }
});

test('schema-lts: legacy v1 index (schemaVersion: 1, base64 vectors) loads seamlessly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-lts-v1-'));
  try {
    const v1Index = {
      schemaVersion: 1,
      format: 'binary-v1',
      model: 'e5-base',
      dim: DIM,
      chunks: [
        {
          file: 'notes.md',
          title: 'Notes',
          heading: 'Intro',
          text: 'Distributed consensus algorithm',
          vec: encodeVec(makeVec()),
        },
      ],
    };

    fs.writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(v1Index));
    const loaded = loadIndex(dir);
    assert.equal(loaded.index.chunks.length, 1);

    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'consensus',
      embedFn: fakeEmbed,
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'notes.md');
  } finally {
    safeRm(dir);
  }
});

test('schema-lts: v3 LTS format preserves all metadata fields, tags, and heading paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-lts-v3-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(
      path.join(dir, 'guide.md'),
      '---\ntitle: Guide\ntags: [security, auth]\n---\n# Guide\n\n## Security\n\nAuthentication protocols and token lifecycle.\n'
    );

    await import('../dist/indexer.js').then((m) =>
      m.buildIndex({
        db: dir,
        indexDir: idx,
        cacheDir: dir,
        modelName: 'e5-base',
        embedFn: fakeEmbed,
      })
    );

    const loaded = loadIndex(idx);
    assert.equal(loaded.index.schemaVersion, 3);
    const secChunk = loaded.index.chunks.find((c) => c.heading === 'Security');
    assert.ok(secChunk);
    assert.deepEqual(secChunk.headingPath, ['Guide', 'Security']);

    const hits = await searchIndex({
      loaded,
      cacheDir: dir,
      query: 'authentication token',
      embedFn: fakeEmbed,
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].heading, 'Security');
  } finally {
    safeRm(dir);
  }
});

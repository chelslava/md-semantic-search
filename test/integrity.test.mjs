import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { loadIndex } from '../src/search.mjs';

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

test('integrity: buildIndex writes vectors.json.sha256 manifest file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-integrity-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'test.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const shaPath = path.join(idx, 'vectors.json.sha256');
    assert.equal(fs.existsSync(shaPath), true, 'vectors.json.sha256 should exist');

    const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
    assert.match(shaContent, /^[a-f0-9]{64}\s+vectors\.json$/);

    // loadIndex succeeds with valid manifest
    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrity: loadIndex detects corrupted byte in vectors.json via SHA-256 manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-integrity-corrupt-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'test.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const vectorsPath = path.join(idx, 'vectors.json');
    const originalContent = fs.readFileSync(vectorsPath, 'utf8');

    // Corrupt one character in vectors.json (while keeping it valid JSON or invalid)
    const corruptedContent = originalContent.replace('Coffee', 'Tea');
    fs.writeFileSync(vectorsPath, corruptedContent);

    // loadIndex must throw SHA-256 mismatch error
    assert.throws(
      () => loadIndex(idx),
      /integrity check failed/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex } from '../dist/search.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

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

test('workers: parallel batch embedding with workers: 4 indexes corpus correctly', async () => {
  const dir = tempDir('workers-test');
  const idx = path.join(dir, '.mdss');
  try {
    // Generate 5 markdown files each with 20 sections = 100 chunks
    for (let f = 0; f < 5; f++) {
      let content = `# Document ${f}\n\n`;
      for (let s = 0; s < 20; s++) {
        content += `## Section ${s}\n\nContent for section ${s} of doc ${f} with keywords alpha beta gamma.\n\n`;
      }
      fs.writeFileSync(path.join(dir, `doc${f}.md`), content);
    }

    const progressCalls = [];
    const res = await buildIndex({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
      workers: 4,
      onProgress: (done, total, speed) => {
        progressCalls.push({ done, total, speed });
      },
    });

    assert.equal(res.files, 5);
    assert.equal(res.chunks, 100);
    assert.equal(res.embedded, 100);
    assert.ok(progressCalls.length > 0);

    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, 100);
    for (const c of loaded.index.chunks) {
      assert.ok(c.vec);
    }

    const searchRes = await searchIndex({ loaded, cacheDir: dir, query: 'alpha beta', k: 3, embedFn: fakeEmbed });
    assert.equal(searchRes.length, 3);
    assert.ok(searchRes[0].score > 0);
  } finally {
    safeRm(dir);
  }
});

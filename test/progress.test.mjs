import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';

function fakeEmbed(texts, kind, model) {
  const dim = model?.dim > 0 ? model.dim : 8;
  return texts.map(() => new Array(dim).fill(0.1));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('buildIndex: onProgress callback fires for embedding batches', async () => {
  const dir = tempDir('progress');
  const idx = path.join(dir, '.mdss');
  try {
    // Write 70 small chunks across files (BATCH is 32, so 3 batches: 32, 64, 70)
    for (let f = 1; f <= 7; f++) {
      let content = `# File ${f}\n\n`;
      for (let s = 1; s <= 10; s++) {
        content += `## Section ${s}\n\nContent for section ${s} in file ${f}.\n\n`;
      }
      fs.writeFileSync(path.join(dir, `doc-${f}.md`), content);
    }

    const progressCalls = [];
    const onProgress = (done, total, chunksPerSec) => {
      progressCalls.push({ done, total, chunksPerSec });
    };

    const res = await buildIndex({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
      onProgress,
    });

    assert.equal(res.chunks, 70);
    assert.equal(res.embedded, 70);
    assert.ok(progressCalls.length >= 3, `expected at least 3 progress calls, got ${progressCalls.length}`);

    // Verify progress parameters
    const lastCall = progressCalls[progressCalls.length - 1];
    assert.equal(lastCall.done, 70);
    assert.equal(lastCall.total, 70);
    assert.ok(typeof lastCall.chunksPerSec === 'number');
    assert.ok(lastCall.chunksPerSec >= 0);

    for (let i = 0; i < progressCalls.length; i++) {
      const call = progressCalls[i];
      assert.equal(call.total, 70);
      assert.ok(call.done <= 70);
      if (i > 0) {
        assert.ok(call.done >= progressCalls[i - 1].done);
      }
    }
  } finally {
    safeRm(dir);
  }
});

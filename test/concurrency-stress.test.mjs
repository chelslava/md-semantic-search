import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { createServe } from '../dist/serve.js';

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

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

test('concurrency: daemon handles 50 parallel search requests without race conditions or errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-concurrent-'));
  const idx = path.join(dir, '.mdss');

  try {
    fs.writeFileSync(path.join(dir, 'doc1.md'), '# Document 1\n\nHigh concurrency stress test content.\n');
    fs.writeFileSync(path.join(dir, 'doc2.md'), '# Document 2\n\nSecondary notes for load testing.\n');

    await buildIndex({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const svc = await createServe({
      db: dir,
      indexDir: idx,
      cacheDir: dir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
      offline: true,
      log: () => {},
    });

    await new Promise((resolve) => svc.server.listen(0, resolve));
    const port = svc.server.address().port;

    // Fire 50 concurrent requests
    const queries = Array.from({ length: 50 }, (_, i) => `document ${i % 2 === 0 ? 'concurrency' : 'secondary'}`);
    const responses = await Promise.all(
      queries.map(async (q) => {
        const res = await fetch(`http://127.0.0.1:${port}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
          body: JSON.stringify({ query: q, k: 2 }),
        });
        if (res.status !== 200) {
          const errText = await res.text();
          throw new Error(`Expected 200, got ${res.status}: ${errText}`);
        }
        return res.json();
      })
    );

    assert.equal(responses.length, 50);
    for (const res of responses) {
      assert.ok(Array.isArray(res.results));
      assert.ok(res.results.length > 0);
    }

    if (typeof svc.server.closeAllConnections === 'function') {
      svc.server.closeAllConnections();
    }
    await svc.close();
  } finally {
    safeRm(dir);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { search, searchIndex, loadIndex } from '../src/search.mjs';
import { createServe } from '../src/serve.mjs';

function fakeEmbed(texts) {
  return texts.map((t) => {
    const v = new Array(8).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % 8] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

async function makeIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rerank-'));
  const idx = path.join(dir, '.mdss');
  // All three chunks share the word "guide" → a "guide" query puts all of them
  // in the candidate pool. a.md is the shortest chunk (first-pass winner under
  // cosine+RRF with fakeEmbed), c.md the longest — a reranker that prefers
  // longer passages will flip the order.
  fs.writeFileSync(path.join(dir, 'a.md'),
    '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
  fs.writeFileSync(path.join(dir, 'b.md'),
    '# Sports\n\n## Hockey\n\nsports guide hockey match puck arena\n');
  fs.writeFileSync(path.join(dir, 'c.md'),
    '# Finance\n\n## Stocks\n\nfinance guide stocks bonds market index\n' +
    'governance regulations compliance audit risk management reporting\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
  return { dir, idx };
}

test('search rerank: DI rerankFn re-orders candidates and adds rerankScore (issue #15)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const calls = [];
    // Reranker that prefers longer passages — c.md is the longest chunk.
    const rerankFn = async (query, texts, cacheDir, offline) => {
      calls.push({ query, texts, cacheDir, offline });
      return texts.map((t) => t.length);
    };

    const base = await search({ indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed });
    assert.equal(base.length, 3, 'all three chunks share "guide" and survive the first pass');
    assert.equal(base[0].file, 'a.md', 'first pass (cosine+RRF) ranks the shortest chunk first');
    assert.equal('rerankScore' in base[0], false, 'no rerankScore without rerank enabled');

    const reranked = await search({
      indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed,
      rerank: true, rerankFn,
    });
    assert.equal(reranked.length, 3);
    assert.equal(reranked[0].file, 'c.md', 'reranker (prefers length) promotes the longest chunk');
    assert.equal(reranked[2].file, 'a.md', 'shortest chunk demoted to last by the reranker');
    for (const r of reranked) {
      assert.equal(typeof r.rerankScore, 'number', 'every result carries a numeric rerankScore');
    }
    assert.ok(reranked.every((r, i) => i === 0 || reranked[i - 1].rerankScore >= r.rerankScore),
      'results sorted descending by rerankScore');

    assert.equal(calls.length, 1, 'rerankFn called exactly once');
    assert.equal(calls[0].query, 'guide');
    assert.equal(calls[0].texts.length, 3, 'all pool candidates scored');
    assert.equal(typeof calls[0].cacheDir, 'string');
    assert.equal(calls[0].offline, false, 'offline flag forwarded to the reranker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search rerank: rerankFn NOT called when rerank is off (lazy model, issue #15)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    let called = false;
    const rerankFn = async () => { called = true; return []; };

    const res = await search({ indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed, rerankFn });
    assert.equal(res.length, 3);
    assert.equal(called, false, 'reranker stays unloaded when rerank is disabled');
    assert.ok(res.every((r) => !('rerankScore' in r)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search rerank: rerankPool caps the candidate pool, k still bounds results (issue #15)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const seen = [];
    const rerankFn = async (_q, texts) => {
      seen.push(texts.length);
      return texts.map((t) => t.length);
    };

    // Pool of 2 but k=3 → only the 2 best first-pass candidates are re-scored,
    // and at most 2 results can survive (the other file never enters the pool).
    const res = await search({
      indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed,
      rerank: true, rerankPool: 2, rerankFn,
    });
    assert.deepEqual(seen, [2], 'reranker sees exactly rerankPool candidates');
    assert.equal(res.length, 2, 'results bounded by the pool size');
    assert.ok(res.every((r) => typeof r.rerankScore === 'number'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex rerank: works on a loaded index with rerankFn (issue #15)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const rerankFn = async (_q, texts) => texts.map((t) => t.length);

    const res = await searchIndex({
      loaded, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed,
      rerank: true, rerankFn,
    });
    assert.equal(res[0].file, 'c.md', 'rerank applies on the loadIndex path too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: POST /search with rerank:true uses the injected reranker (issue #15)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rerank-serve-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'),
      '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    fs.writeFileSync(path.join(dir, 'c.md'),
      '# Finance\n\n## Stocks\n\nfinance guide stocks bonds market index\n' +
      'governance regulations compliance audit risk management reporting\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const rerankFn = async (_q, texts) => texts.map((t) => t.length);
    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, rerankFn });
    await new Promise((resolve) => svc.server.listen(0, resolve));
    const { port } = svc.server.address();
    const url = `http://127.0.0.1:${port}`;
    try {
      const off = await fetch(`${url}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'guide', k: 3 }),
      }).then((r) => r.json());
      assert.equal(off.results[0].file, 'a.md', 'without rerank the shortest chunk wins');
      assert.ok(off.results.every((r) => !('rerankScore' in r)));

      const on = await fetch(`${url}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'guide', k: 3, rerank: true }),
      }).then((r) => r.json());
      assert.equal(on.results[0].file, 'c.md', 'rerank:true promotes the longest chunk');
      assert.ok(on.results.every((r) => typeof r.rerankScore === 'number'));
    } finally {
      await svc.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

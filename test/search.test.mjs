import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { search, tokenize, keywordScores, rrf } from '../src/search.mjs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-search-'));
  const idx = path.join(dir, '.mdss');
  // every chunk shares the word "guide" so a "guide" query hits all three
  fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
  fs.writeFileSync(path.join(dir, 'b.md'), '# Sports\n\n## Hockey\n\nsports guide hockey match puck arena\n');
  fs.writeFileSync(path.join(dir, 'c.md'), '# Finance\n\n## Stocks\n\nfinance guide stocks bonds market index\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
  return { dir, idx };
}

test('tokenize: lowercase, min length 3, unicode, strips function words', () => {
  assert.deepEqual(tokenize('The cat and the hat'), ['cat', 'hat']);
  assert.deepEqual(tokenize('ab cd e'), []);
  assert.deepEqual(tokenize('Привет мир'), ['привет', 'мир']);
  assert.deepEqual(tokenize('C++ win32-api'), ['win32', 'api']);
});

test('keywordScores: counts query terms found in chunk text', () => {
  const chunks = [
    { title: '', heading: '', text: 'win32 stdin buffer closes' },
    { title: '', heading: '', text: 'monaco editor spaces' },
  ];
  const s = keywordScores(chunks, 'win32 buffer');
  assert.equal(s[0], 2);
  assert.equal(s[1], 0);
});

test('rrf: fuses rankings by position with k=60, skips non-positive scores', () => {
  const fused = rrf([
    [{ idx: 5, score: 1 }, { idx: 6, score: 0.9 }],
    [{ idx: 5, score: 0 }],          // non-positive → skipped entirely
    [{ idx: 7, score: 1 }],
  ]);
  assert.equal(fused.get(5), 1 / 61);
  assert.equal(fused.get(6), 1 / 62);
  assert.equal(fused.get(7), 1 / 61);
  assert.equal(fused.size, 3);
});

test('search: returns results with expected shape, hybrid and semanticOnly', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const opts = { indexDir: idx, cacheDir: dir, k: 3, embedFn: fakeEmbed };

    // "guide" is shared by all chunks → all three survive RRF (positive lexical score)
    const hybrid = await search({ ...opts, query: 'guide' });
    assert.equal(hybrid.length, 3);

    for (const r of hybrid) {
      assert.ok(typeof r.file === 'string' && typeof r.title === 'string');
      assert.ok(typeof r.heading === 'string');
      assert.ok(typeof r.cosine === 'number' && r.cosine >= -1 && r.cosine <= 1);
      assert.ok(typeof r.score === 'number');
      assert.ok(typeof r.snippet === 'string' && r.snippet.length <= 220);
    }

    // lexical: "coffee" only occurs in a.md → hybrid RRF ranks it first
    const coffee = await search({ ...opts, query: 'coffee' });
    assert.equal(coffee[0].file, 'a.md', 'coffee query ranks the coffee chunk first');

    // semantic: a query identical to one chunk's text must rank that chunk first
    const semantic = await search({ ...opts, query: 'coffee guide beans roasted ground', semanticOnly: true });
    assert.equal(semantic[0].file, 'a.md', 'semantic-only ranks the identical chunk first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: honors k and returns no matches gracefully', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const one = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 1, embedFn: fakeEmbed });
    assert.equal(one.length, 1);

    const miss = await search({ indexDir: idx, cacheDir: dir, query: 'zzqqxx', k: 3, embedFn: fakeEmbed });
    assert.equal(miss.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: throws with clear message when index is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-noidx-'));
  try {
    await assert.rejects(
      () => search({ indexDir: path.join(dir, '.mdss'), cacheDir: dir, query: 'x', embedFn: fakeEmbed }),
      /No index at .*\.mdss.*Run `mdss index` first/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: legacy index without model fields still works (validation fallback)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // simulate a v0.1.x index: no model / modelAlias fields at all
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    delete index.model;
    delete index.modelAlias;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const results = await search({ indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed });
    assert.equal(results.length, 3, 'search proceeds on a legacy index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

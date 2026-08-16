import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildIndex } from '../dist/indexer.js';
import { search, searchIndex, loadIndex, tokenize, keywordScores, rrf, _stats } from '../dist/search.js';
import { decodeVec, SCHEMA_VERSION } from '../dist/core.js';

function writeIndex(idx, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const vectorsPath = path.join(idx, 'vectors.json');
  fs.writeFileSync(vectorsPath, json);
  const shaPath = path.join(idx, 'vectors.json.sha256');
  const digest = crypto.createHash('sha256').update(json).digest('hex');
  fs.writeFileSync(shaPath, `${digest}  vectors.json\n`);
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

function poisonLoadedState(loaded) {
  const chunk = loaded.index.chunks[0];
  const sparseVector = new Array(chunk.vec.length);
  sparseVector[0] = 1;
  chunk.file = 'mutated.md';
  chunk.title = 'Mutated title';
  chunk.heading = 'Mutated heading';
  chunk.text = 'mutated text must never reach results';
  chunk.vec = sparseVector;
  loaded.index.db = path.join(loaded.index.db, 'missing');
  loaded.index.dim = 1;
  loaded.index.schemaVersion = 2;
  loaded.index.lexical.documentLengths[0] = 0;
  delete loaded.index.lexical.postings.coffee;
  loaded.model.id = 'Xenova/mutated-model';
  loaded.model.dim = 1;
}

test('tokenize: lowercase, min length 2, unicode, strips function words', () => {
  assert.deepEqual(tokenize('The cat and the hat'), ['cat', 'hat']);
  assert.deepEqual(tokenize('in of to it is'), []);
  assert.deepEqual(tokenize('Привет мир'), ['привет', 'мир']);
  assert.deepEqual(tokenize('C++ win32-api'), ['c++', 'win32-api']);
});

test('tokenize: short identifiers survive the 2-char floor (issue #22)', () => {
  // go/io/jq are plain 2-letter words but real search terms — kept.
  // V8/d3/es7 are code-y (digit) — kept. is/to/in/of/it are STOP — dropped.
  assert.deepEqual(tokenize('go io V8 d3 jq es7 is to in of it'),
    ['go', 'io', 'v8', 'd3', 'jq', 'es7']);
  // C#/C++ keep their symbols (issue #22).
  assert.deepEqual(tokenize('C# and C++ are languages, go is a toolchain, io is Node'),
    ['c#', 'c++', 'languages', 'go', 'toolchain', 'io', 'node']);
  // Tokens must start with a letter/digit — markdown noise never becomes a token.
  assert.deepEqual(tokenize('## Heading\n---\nfoo\n+++'), ['heading', 'foo']);
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

test('keywordScores: content word "код" is NOT a stop-word (issue #7)', () => {
  const chunks = [
    { title: '', heading: '', text: 'как устроен код и его структура' },
    { title: '', heading: '', text: 'рецепты выпечки хлеба' },
  ];
  const s = keywordScores(chunks, 'код структура');
  assert.equal(s[0], 2, '"код" and "структура" both overlap the code chunk');
  assert.equal(s[1], 0);
});

test('keywordScores: exact token overlap, no substring matching (issue #7)', () => {
  const chunks = [
    { title: '', heading: '', text: 'a window closes over the yard' },
    { title: '', heading: '', text: 'the win is a rare victory marker' },
  ];
  const s = keywordScores(chunks, 'win');
  assert.equal(s[0], 0, '"win" must NOT match "window" via substring');
  assert.equal(s[1], 1, '"win" token present verbatim in second chunk');
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

test('rrf: equal scores receive equal rank contributions', () => {
  const fused = rrf([[{ idx: 5, score: 1 }, { idx: 6, score: 1 }]]);

  assert.equal(fused.get(5), 1 / 61);
  assert.equal(fused.get(6), 1 / 61);
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

// ---- token-set cache (issue #18): the corpus is tokenized ONCE per loaded
// index, never per query; --semantic performs zero lexical work. -------------

test('issue #18: two queries on one loaded index tokenize the corpus once', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const vectorsPath = path.join(idx, 'vectors.json');
    const legacy = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    legacy.schemaVersion = 2;
    delete legacy.lexical;
    writeIndex(idx, legacy);
    const loaded = loadIndex(idx);
    const before = _stats.corpusTokenizedChars;
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    const afterFirst = _stats.corpusTokenizedChars;
    const perQuery = loaded.index.chunks
      .map(c => `${c.title} ${c.heading} ${c.text}`.length)
      .reduce((a, b) => a + b, 0);
    assert.equal(afterFirst - before, perQuery,
      'first query tokenizes every chunk exactly once');
    await searchIndex({ loaded, cacheDir: dir, query: 'hockey', k: 3, embedFn: fakeEmbed });
    await searchIndex({ loaded, cacheDir: dir, query: 'stocks', k: 3, embedFn: fakeEmbed });
    assert.equal(_stats.corpusTokenizedChars, afterFirst,
      'second/third query reuse the cache — zero corpus re-tokenization');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('issue #18: --semantic performs zero lexical corpus tokenization', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    // populate the cache with a hybrid query first — cache presence must NOT
    // change the semantic lane's behavior
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    const before = _stats.corpusTokenizedChars;
    const r = await searchIndex({ loaded, cacheDir: dir, query: 'hockey',
      k: 3, semanticOnly: true, embedFn: fakeEmbed });
    assert.equal(_stats.corpusTokenizedChars, before,
      'semanticOnly: no chunk is tokenized, cache not even consulted');
    assert.ok(r.length > 0 && r[0].cosine !== undefined, 'results still ranked by cosine');
    assert.ok(Array.isArray(r[0].matches) && r[0].matches.length >= 0, 'matches field present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('issue #18: cache is per chunks array — a --path filter reuses token sets', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    const before = _stats.corpusTokenizedChars;
    // --path makes .filter() produce a NEW chunks array per query — but the
    // chunk OBJECTS are shared with index.chunks, and the cache is keyed per
    // chunk object. Filtered queries must therefore be FREE on a warm index:
    // zero tokenization for the first and the Nth filtered query.
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3,
      path: 'a.md', embedFn: fakeEmbed });
    assert.equal(_stats.corpusTokenizedChars, before,
      'first filtered query on a warm cache: zero tokenization');
    await searchIndex({ loaded, cacheDir: dir, query: 'stocks', k: 3,
      path: 'a.md', embedFn: fakeEmbed });
    assert.equal(_stats.corpusTokenizedChars, before,
      'second filtered query: still zero');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keywordScores: same array in → same cached sets, identical scores twice', () => {
  const chunks = [
    { title: 'Win32 API', heading: 'Buffer', text: 'rotate the win32 buffer safely' },
    { title: 'Backups', heading: 'Restore', text: 'restore from a nightly backup' },
  ];
  const s1 = keywordScores(chunks, 'win32 buffer');
  const s2 = keywordScores(chunks, 'backup restore');
  const s3 = keywordScores(chunks, 'win32 buffer');
  assert.deepEqual(s1, s3, 'cached corpus → deterministic scores');
  assert.deepEqual(s1, [2, 0]);
  assert.deepEqual(s2, [0, 2]);
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
    index.schemaVersion = 2;
    delete index.lexical;
    delete index.model;
    delete index.modelAlias;
    writeIndex(idx, index);

    const results = await search({ indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed });
    assert.equal(results.length, 3, 'search proceeds on a legacy index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: schema-v1 index without headingPath remains searchable with unchanged hit shape', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = 1;
    for (const chunk of index.chunks) delete chunk.headingPath;
    writeIndex(idx, index);

    const results = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 1, embedFn: fakeEmbed });

    assert.equal(results.length, 1);
    assert.deepEqual(Object.keys(results[0]).sort(), [
      'cosine', 'file', 'heading', 'matches', 'score', 'snippet', 'title',
    ]);
    assert.equal('headingPath' in results[0], false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: legacy decimal vectors.json loads and ranks identically (issue #4)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const binaryResults = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });

    // convert the binary index to the legacy ≤0.3.x shape: decimal arrays, no format field
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = 2;
    delete index.lexical;
    delete index.format;
    for (const c of index.chunks) c.vec = [...decodeVec(c.vec)];
    writeIndex(idx, index);

    const legacyResults = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });

    assert.equal(legacyResults.length, binaryResults.length, 'same hit count');
    assert.deepEqual(
      legacyResults.map(r => r.file),
      binaryResults.map(r => r.file),
      'identical ranking order',
    );
    for (let i = 0; i < binaryResults.length; i++) {
      assert.ok(Math.abs(legacyResults[i].cosine - binaryResults[i].cosine) < 1e-4,
        `cosine delta at rank ${i} < 1e-4`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex/searchIndex: parse once, reuse across queries (issues #14+#2)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    assert.deepEqual(Object.keys(loaded).sort(), ['index', 'model']);
    assert.ok(loaded.index.chunks.length >= 3, 'index parsed once');
    assert.equal(loaded.model.id, 'Xenova/multilingual-e5-base', 'model resolved from index');

    const q1 = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    const q2 = await searchIndex({ loaded, cacheDir: dir, query: 'hockey', k: 3, embedFn: fakeEmbed });
    assert.equal(q1[0].file, 'a.md', 'coffee ranks a.md first');
    assert.equal(q2[0].file, 'b.md', 'hockey ranks b.md first');

    // results identical to the one-shot path (same parse, same ranking)
    const oneShot = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    assert.deepEqual(q1.map(r => r.file), oneShot.map(r => r.file), 'loadIndex path == one-shot path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: v0/v1/v2 retain the explicit legacy overlap lexical state', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const current = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    for (const schemaVersion of [0, 1, 2]) {
      const legacy = structuredClone(current);
      if (schemaVersion === 0) delete legacy.schemaVersion;
      else legacy.schemaVersion = schemaVersion;
      delete legacy.lexical;
      writeIndex(idx, legacy);
      const loaded = loadIndex(idx);
      assert.deepEqual(Object.keys(loaded).sort(), ['index', 'model']);
      assert.equal(loaded.index.schemaVersion, schemaVersion === 0 ? undefined : schemaVersion,
        'loading does not relabel legacy state as schema v3');
      const transferred = structuredClone(loaded);
      const before = _stats.corpusTokenizedChars;
      const results = await searchIndex({ loaded: transferred, cacheDir: dir,
        query: 'coffee', k: 1, embedFn: fakeEmbed });
      assert.equal(results[0].file, 'a.md');
      assert.ok(_stats.corpusTokenizedChars > before,
        `transferred schema v${schemaVersion} uses overlap token sets without WeakMap state`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: genuine v3 missing or corrupt lexical data fails with rebuild hint', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const vectorsPath = path.join(idx, 'vectors.json');
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    const invalid = [
      { name: 'missing', lexical: undefined },
      { name: 'wrong format', lexical: { ...current.lexical, format: 'unknown' } },
      { name: 'wrong length', lexical: { ...current.lexical, documentLengths: [] } },
    ];
    for (const fixture of invalid) {
      const value = structuredClone(current);
      if (fixture.lexical === undefined) delete value.lexical;
      else value.lexical = fixture.lexical;
      fs.writeFileSync(vectorsPath, JSON.stringify(value));
      assert.throws(() => loadIndex(idx), /schema v3 lexical index.*mdss index.*rebuild/i, fixture.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: malformed roots, chunks, and schemaVersion fail before migration', async () => {
  const { dir, idx } = await makeIndex();
  const vectorsPath = path.join(idx, 'vectors.json');
  try {
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    for (const root of [null, [], 'index']) {
      fs.writeFileSync(vectorsPath, JSON.stringify(root));
      assert.throws(() => loadIndex(idx), /root must be an object.*mdss index/i);
    }
    fs.writeFileSync(vectorsPath, JSON.stringify({ ...current, chunks: null }));
    assert.throws(() => loadIndex(idx), /chunks must be an array.*mdss index/i);
    fs.writeFileSync(vectorsPath, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, chunks: null }));
    assert.throws(() => loadIndex(idx), /uses schema v4.*upgrade md-semantic-search/i,
      'future schema authority is checked before malformed chunks');
    for (const schemaVersion of ['3', 3.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      fs.writeFileSync(vectorsPath, JSON.stringify({ ...current, schemaVersion }));
      assert.throws(() => loadIndex(idx), /schemaVersion must be a non-negative safe integer.*mdss index/i);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('loadIndex: schema-v3 envelope and chunks fail closed with actionable errors', async () => {
  const { dir, idx } = await makeIndex();
  const vectorsPath = path.join(idx, 'vectors.json');
  try {
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    const first = current.chunks[0];
    const cases = [
      ['null chunk', { ...current, chunks: [null], chunkCount: 1 }, /chunk 0 must be an object/i],
      ['unknown format', { ...current, format: 'binary-v9' }, /schema v3 format must be binary-v1/i],
      ['missing chunk count', { ...current, chunkCount: undefined }, /chunkCount must equal chunks\.length/i],
      ['fractional chunk count', { ...current, chunkCount: 1.5 }, /chunkCount must equal chunks\.length/i],
      ['unsafe chunk count', { ...current, chunkCount: Number.MAX_SAFE_INTEGER + 1 }, /chunkCount must equal chunks\.length/i],
      ['chunk count', { ...current, chunkCount: current.chunks.length + 1 }, /chunkCount must equal chunks\.length/i],
      ['missing model', { ...current, model: undefined }, /schema v3 model must be a nonempty string/i],
      ['empty model', { ...current, model: '   ' }, /schema v3 model must be a nonempty string/i],
      ['missing metadata', { ...current, chunks: [{ ...first, chunkHash: undefined }, ...current.chunks.slice(1)] }, /chunk 0 chunkHash must be a string/i],
      ['bad heading path', { ...current, chunks: [{ ...first, headingPath: ['Coffee Guide', ''] }, ...current.chunks.slice(1)] }, /chunk 0 headingPath/i],
      ['wrong leaf', { ...current, chunks: [{ ...first, headingPath: ['Coffee Guide', 'Other'] }, ...current.chunks.slice(1)] }, /chunk 0 headingPath leaf must equal heading/i],
      ['empty base64', { ...current, chunks: [{ ...first, vec: '' }, ...current.chunks.slice(1)] }, /chunk 0.*base64 vector.*empty/i],
      ['invalid base64', { ...current, chunks: [{ ...first, vec: '!!!!' }, ...current.chunks.slice(1)] }, /chunk 0.*base64 vector.*canonical/i],
      ['decimal current vector', { ...current, chunks: [{ ...first, vec: [1, 0] }, ...current.chunks.slice(1)] }, /chunk 0 vec must be canonical base64/i],
    ];
    for (const [name, value, expected] of cases) {
      fs.writeFileSync(vectorsPath, JSON.stringify(value));
      assert.throws(() => loadIndex(idx), expected, name);
    }

    const custom = structuredClone(current);
    custom.model = 'Xenova/reviewer-custom-model@main';
    delete custom.modelAlias;
    delete custom.dim;
    fs.writeFileSync(vectorsPath, JSON.stringify(custom));
    assert.throws(() => loadIndex(idx), /nonempty schema v3 custom index requires explicit dim/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: rejects sparse stored and query vectors', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const sparseChunk = new Array(768);
    sparseChunk[0] = 1;
    const chunkIndex = structuredClone(loaded.index);
    chunkIndex.chunks[0].vec = sparseChunk;
    await assert.rejects(
      searchIndex({ loaded: { index: chunkIndex, model: loaded.model }, cacheDir: dir,
        query: 'coffee', k: 1, embedFn: fakeEmbed }),
      /missing vector component.*mdss index/i,
    );

    const sparseQuery = new Array(768);
    sparseQuery[0] = 1;
    await assert.rejects(
      searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
        embedFn: () => [sparseQuery] }),
      /missing vector component.*mdss index/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: validates a transferred index once and only validates each new query vector', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const persisted = loadIndex(idx);
    let headingPathReads = 0;
    const index = structuredClone(persisted.index);
    index.chunks = index.chunks.map(chunk => new Proxy(chunk, {
      get(target, property, receiver) {
        if (property === 'headingPath') headingPathReads++;
        return Reflect.get(target, property, receiver);
      },
    }));
    const transferred = { index, model: persisted.model };

    await searchIndex({ loaded: transferred, cacheDir: dir, query: 'coffee', k: 1, embedFn: fakeEmbed });
    const afterFirst = headingPathReads;
    assert.ok(afterFirst > 0, 'first query validates the transferred index');
    await searchIndex({ loaded: transferred, cacheDir: dir, query: 'hockey', k: 1, embedFn: fakeEmbed });

    assert.equal(headingPathReads, afterFirst, 'second query reuses cached runtime validation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: mutations after load cannot change the owned runtime snapshot', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    poisonLoadedState(loaded);

    const results = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
      since: new Date(0), embedFn: fakeEmbed });

    assert.equal(results[0].file, 'a.md');
    assert.equal(results[0].title, 'Coffee Guide');
    assert.ok(Number.isFinite(results[0].cosine));
    assert.ok(Number.isFinite(results[0].score));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: mutations after the first query cannot change later searches', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const first = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
      since: new Date(0), embedFn: fakeEmbed });
    poisonLoadedState(loaded);

    const second = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
      since: new Date(0), embedFn: fakeEmbed });

    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: mutations during embed await cannot affect the in-flight or later search', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const queryVector = fakeEmbed(['coffee'], 'query', loaded.model)[0];
    let signalStarted;
    let releaseEmbed;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const embedFn = () => {
      signalStarted();
      return new Promise(resolve => { releaseEmbed = resolve; });
    };
    const pending = searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
      since: new Date(0), embedFn });
    await started;
    poisonLoadedState(loaded);
    releaseEmbed([queryVector]);

    const inFlight = await pending;
    const later = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
      since: new Date(0), embedFn: () => [queryVector] });

    assert.equal(inFlight[0].file, 'a.md');
    assert.deepEqual(later, inFlight);
    assert.ok(Number.isFinite(inFlight[0].cosine));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: direct invalid objects reject before their first runtime snapshot', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const invalidVector = structuredClone(loaded.index);
    invalidVector.chunks[0].vec[0] = NaN;
    await assert.rejects(
      searchIndex({ loaded: { index: invalidVector, model: structuredClone(loaded.model) },
        cacheDir: dir, query: 'coffee', k: 1, embedFn: fakeEmbed }),
      /non-finite vector value.*mdss index/i,
    );

    const invalidPath = structuredClone(loaded.index);
    const sparsePath = new Array(2);
    sparsePath[1] = invalidPath.chunks[0].heading;
    invalidPath.chunks[0].headingPath = sparsePath;
    await assert.rejects(
      searchIndex({ loaded: { index: invalidPath, model: structuredClone(loaded.model) },
        cacheDir: dir, query: 'coffee', k: 1, embedFn: fakeEmbed }),
      /headingPath must contain nonempty strings.*mdss index/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: direct loaded model substitution cannot override canonical index metadata', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const persisted = loadIndex(idx);
    const directIndex = structuredClone(persisted.index);
    const substitutedModel = {
      ...persisted.model,
      id: 'Xenova/substituted-same-dimension-model',
      passagePrefix: 'substituted: ',
      queryPrefix: 'substituted: ',
    };
    let receivedModel;
    const embedFn = (texts, kind, model) => {
      receivedModel = model;
      return fakeEmbed(texts, kind, model);
    };

    await searchIndex({ loaded: { index: directIndex, model: substitutedModel },
      cacheDir: dir, query: 'coffee', k: 1, embedFn });

    assert.equal(receivedModel.id, 'Xenova/multilingual-e5-base');
    assert.equal(receivedModel.revision, 'main');
    assert.equal(receivedModel.queryPrefix, 'query: ');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: raw registry model ids enforce known dimensions', async () => {
  const { dir, idx } = await makeIndex();
  const vectorsPath = path.join(idx, 'vectors.json');
  try {
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    delete current.modelAlias;
    current.model = 'Xenova/multilingual-e5-base@review47';
    current.dim = 7;
    fs.writeFileSync(vectorsPath, JSON.stringify(current));
    assert.throws(() => loadIndex(idx), /index\.dim 7 does not match known model dimension 768/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: direct schema-v3 missing lexical data never downgrades to overlap', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const directIndex = structuredClone(loaded.index);
    delete directIndex.lexical;
    await assert.rejects(
      searchIndex({ loaded: { index: directIndex, model: loaded.model }, cacheDir: dir,
        query: 'coffee', k: 1, embedFn: fakeEmbed }),
      /schema v3 lexical index.*mdss index.*rebuild/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex: query vector dimension must match the trusted index dimension', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    await assert.rejects(
      searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 1,
        embedFn: () => [[1, 0, 0]] }),
      /query vector has 3 dims, expected 768.*mdss index/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: index.dim is positive, safe, and consistent with a known model', async () => {
  const { dir, idx } = await makeIndex();
  const vectorsPath = path.join(idx, 'vectors.json');
  try {
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    for (const dim of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      fs.writeFileSync(vectorsPath, JSON.stringify({ ...current, dim }));
      assert.throws(() => loadIndex(idx), /index\.dim must be a positive safe integer.*mdss index/i);
    }
    fs.writeFileSync(vectorsPath, JSON.stringify({ ...current, dim: 7 }));
    assert.throws(() => loadIndex(idx), /index\.dim 7 does not match known model dimension 768.*mdss index/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: decimal vectors reject non-finite and non-number entries', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = 2;
    delete index.lexical;
    delete index.format;
    index.model = 'Xenova/test-model@main';
    delete index.modelAlias;
    index.chunks = index.chunks.map((chunk) => ({
      ...chunk, vec: new Array(768).fill(0).map((value, position) => position === 1 ? null : value),
    }));
    writeIndex(idx, index);
    assert.throws(() => loadIndex(idx), /non-finite vector value.*mdss index/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: schema-v3 BM25 does not rank rare ZXQ-47 below legacy overlap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rare-zxq-'));
  const idx = path.join(dir, '.mdss');
  const neutralEmbed = (texts) => texts.map(() => [1, 0]);
  try {
    fs.writeFileSync(path.join(dir, 'common.md'), '# Common\n\n## Guide\n\ncommon guide words repeated common guide words here\n');
    fs.writeFileSync(path.join(dir, 'rare.md'), '# Incident\n\n## ZXQ-47\n\nZXQ-47 identifies the exact rare incident recovery procedure\n');
    fs.writeFileSync(path.join(dir, 'other.md'), '# Other\n\n## Notes\n\nunrelated neutral content for deterministic ranking\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'Xenova/reviewer-custom-model', embedFn: neutralEmbed });
    const persisted = loadIndex(idx);
    const v3 = await searchIndex({ loaded: persisted, cacheDir: dir,
      query: 'ZXQ-47', k: 3, embedFn: neutralEmbed });
    const legacyIndex = structuredClone(persisted.index);
    legacyIndex.schemaVersion = 2;
    delete legacyIndex.lexical;
    const legacy = await searchIndex({ loaded: { index: legacyIndex, model: persisted.model },
      cacheDir: dir, query: 'ZXQ-47', k: 3, embedFn: neutralEmbed });
    const v3Rank = v3.findIndex((hit) => hit.file === 'rare.md');
    const legacyRank = legacy.findIndex((hit) => hit.file === 'rare.md');
    assert.equal(v3[0].cosine, legacy[0].cosine, 'semantic scores are neutral');
    assert.ok(v3Rank >= 0 && legacyRank >= 0);
    assert.ok(v3Rank <= legacyRank, `v3 rank ${v3Rank} must not be worse than legacy ${legacyRank}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: section-title plus shared body term ranks the contextual descendant first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-contextual-bm25-'));
  const idx = path.join(dir, '.mdss');
  const neutralEmbed = (texts) => texts.map(() => [1, 0]);
  try {
    // Given: both chunks contain the body term, while only the descendant has Deployment in its ancestor path.
    fs.writeFileSync(path.join(dir, 'a-noise.md'), '# Notes\n\n## Miscellany\n\ngeneric recovery steps for routine work\n');
    fs.writeFileSync(path.join(dir, 'b-context.md'),
      '# Handbook\n\n## Deployment\n\n### Rollback\n\ngeneric recovery steps without the ancestor term\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'Xenova/reviewer-custom-model', embedFn: neutralEmbed });

    // When: hybrid search receives the section title plus shared body term with tied semantic scores.
    const results = await searchIndex({ loaded: loadIndex(idx), cacheDir: dir,
      query: 'deployment recovery', k: 2, embedFn: neutralEmbed });

    // Then: contextual BM25 moves the descendant ahead and reports the lexical match.
    assert.equal(results[0].file, 'b-context.md');
    assert.deepEqual(results[0].matches, ['deployment', 'recovery']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: v3 filtering keeps canonical doc IDs for BM25, cosine, matches, and lookup', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const results = await searchIndex({
      loaded, cacheDir: dir, query: 'stocks coffee', k: 3, path: ['a.md', 'c.md'], embedFn: fakeEmbed,
    });
    const coffee = results.find((result) => result.file === 'a.md');
    const stocks = results.find((result) => result.file === 'c.md');
    assert.deepEqual(coffee.matches, ['coffee']);
    assert.deepEqual(stocks.matches, ['stocks']);
    assert.ok(results.every((result) => result.file !== 'b.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: genuine v3 hybrid, semantic, filtered, and matches paths tokenize no corpus text', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const loaded = loadIndex(idx);
    const before = _stats.corpusTokenizedChars;
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 3, embedFn: fakeEmbed });
    await searchIndex({ loaded, cacheDir: dir, query: 'coffee coffee', k: 3, embedFn: fakeEmbed });
    const semantic = await searchIndex({
      loaded, cacheDir: dir, query: 'hockey coffee hockey', k: 3, semanticOnly: true, embedFn: fakeEmbed,
    });
    await searchIndex({ loaded, cacheDir: dir, query: 'stocks', k: 3, path: 'c.md', embedFn: fakeEmbed });
    assert.equal(_stats.corpusTokenizedChars, before);
    const hockey = semantic.find((result) => result.file === 'b.md');
    assert.deepEqual(hockey.matches, ['hockey'], 'v3 semantic-only matches use postings and query order');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: throws with clear message when index is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-noidx2-'));
  try {
    assert.throws(() => loadIndex(path.join(dir, '.mdss')), /No index at .*\.mdss.*Run `mdss index` first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: --path glob restricts results to matching files (issue #13)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const opts = { indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed };
    const all = await search(opts);
    assert.equal(all.length, 3, 'no filter → all three files match "guide"');

    const onlyA = await search({ ...opts, path: 'a.md' });
    assert.ok(onlyA.length >= 1 && onlyA.every(r => r.file === 'a.md'), 'path a.md keeps only a.md');

    const aOrB = await search({ ...opts, path: ['a.md', 'b.md'] });
    assert.equal(aOrB.length, 2);
    assert.ok(aOrB.every(r => r.file === 'a.md' || r.file === 'b.md'), 'multiple path globs are OR-ed');

    const none = await search({ ...opts, path: 'zz/**' });
    assert.equal(none.length, 0, 'non-matching glob → no results');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: --since filters by file mtime (issue #13)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'a.md'), old, old); // a.md aged to 2020
    // b.md / c.md keep their fresh creation mtime

    const opts = { indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed, since: '2021-01-01' };
    const res = await search(opts);
    assert.equal(res.length, 2, 'a.md (2020) excluded, b.md + c.md kept');
    assert.ok(res.every(r => r.file !== 'a.md'));
    assert.deepEqual(res.map(r => r.file).sort(), ['b.md', 'c.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: invalid --since value throws a clear error (issue #13)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    await assert.rejects(
      () => search({ indexDir: idx, cacheDir: dir, query: 'guide', embedFn: fakeEmbed, since: 'not-a-date' }),
      /Invalid --since date/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: results carry matches — query terms found in each chunk (issue #13)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const res = await search({ indexDir: idx, cacheDir: dir, query: 'coffee hockey', k: 5, embedFn: fakeEmbed });
    const a = res.find(r => r.file === 'a.md');
    const b = res.find(r => r.file === 'b.md');
    assert.ok(a, 'a.md present in results');
    assert.ok(b, 'b.md present in results');
    assert.ok(Array.isArray(a.matches) && a.matches.includes('coffee'), 'a.md matches include "coffee"');
    assert.ok(Array.isArray(b.matches) && b.matches.includes('hockey'), 'b.md matches include "hockey"');
    assert.ok(!a.matches.includes('hockey'), 'a.md does not match "hockey"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Run an async fn with process.stderr captured; returns {value, stderr}. */
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  try {
    const value = await fn();
    return { value, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

test('loadIndex: corrupt vectors.json gets a clear error naming the file (issue #20)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-corrupt-'));
  try {
    const idx = path.join(dir, '.mdss');
    fs.mkdirSync(idx, { recursive: true });
    fs.writeFileSync(path.join(idx, 'vectors.json'), '{ not valid json !!!');
    assert.throws(
      () => loadIndex(idx),
      /vectors\.json is not valid JSON.*mdss index/,
      'error names the file and the fix, no raw stack trace',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: wrong-dim vector is caught with the chunk identity (issue #40)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // corrupt the vec of a known chunk: decode, truncate to 3 dims, re-encode.
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    const c = index.chunks.find(c => c.file === 'a.md');
    assert.ok(c, 'a.md chunk present');
    c.vec = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64');
    writeIndex(idx, index);

    assert.throws(
      () => loadIndex(idx),
      /chunk a\.md.*corrupt vector: 3 dims, expected 768.*mdss index/,
      'error names the file/chunk and the rebuild hint',
    );
    // and search() surfaces the same error instead of returning NaN scores
    await assert.rejects(
      search({ indexDir: idx, cacheDir: dir, query: 'guide', k: 3, embedFn: fakeEmbed }),
      /chunk a\.md.*corrupt vector/,
      'search propagates the load error',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: decimal-array chunk with wrong dim is caught too (issue #40)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // honest legacy shape: no format field, ALL vecs as decimal arrays — then
    // corrupt one chunk with a wrong-length decimal array
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = 2;
    delete index.lexical;
    delete index.format; // make it look like a legacy ≤0.3.x index
    for (const c of index.chunks) c.vec = [...decodeVec(c.vec)];
    index.chunks.find(c => c.file === 'b.md').vec = [1, 2, 3];
    writeIndex(idx, index);

    assert.throws(
      () => loadIndex(idx),
      /chunk b\.md.*vector has 3 dims, expected 768.*mdss index/,
      'decimal-array dim mismatch rejected',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: newer schemaVersion → clear upgrade error (issue #39)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = SCHEMA_VERSION + 1; // written by a future mdss
    writeIndex(idx, index);

    assert.throws(
      () => loadIndex(idx),
      new RegExp(`uses schema v${SCHEMA_VERSION + 1}.*supports up to v${SCHEMA_VERSION}.*upgrade md-semantic-search`),
      'clear upgrade-required error, no silent misparse',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: writes schemaVersion and re-indexes a legacy v0 index (issue #39)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // simulate a pre-schemaVersion index: drop the field, keep binary-v1 shape
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    delete index.schemaVersion;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const r = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(r.files, 3, 'legacy index re-indexed');
    const written = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    assert.equal(written.schemaVersion, SCHEMA_VERSION, 'schemaVersion written back');
    // and it loads cleanly
    assert.ok(loadIndex(idx), 'rebuilt index loads');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: newer schemaVersion refuses to rebuild over a future index (issue #39)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.schemaVersion = SCHEMA_VERSION + 1;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed }),
      /uses schema v\d+.*upgrade md-semantic-search before re-indexing/,
      'refuses to clobber an index it cannot understand',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: corrupt vector in the old index is dropped and re-embedded (issue #40)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // corrupt ONE chunk's base64 with a non-finite value (NaN float32)
    const nanB64 = (() => {
      const values = new Float32Array(768);
      values[0] = NaN;
      return Buffer.from(values.buffer).toString('base64');
    })();
    const index = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    index.chunks.find(c => c.file === 'a.md').vec = nanB64;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const stderrChunks = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { stderrChunks.push(String(s)); return true; };
    let r;
    try {
      r = await buildIndex({
        db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed,
        log: s => stderrChunks.push(String(s)),
      });
    } finally {
      process.stderr.write = orig;
    }

    assert.match(stderrChunks.join(''), /warning: dropping corrupt vector for a\.md.*non-finite/,
      'corrupt chunk reported');
    const written = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    const fixed = written.chunks.find(c => c.file === 'a.md');
    assert.equal(decodeVec(fixed.vec).length, 768, 'chunk re-embedded with the model dimension');
    // the re-indexed index loads and searches cleanly
    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, written.chunks.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search: stale index warns on stderr but still returns results (issue #20)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    // touch a file AFTER the index was built → index is now stale. The mtime
    // must be *clearly* newer than `built`: filesystem mtime granularity varies
    // (ext4 ns vs overlayfs 1s), and a same-millisecond rewrite may not look
    // newer than the ISO `built` timestamp on fast CI runners — pin it forward.
    const f = path.join(dir, 'b.md');
    fs.writeFileSync(f, '# Sports\n\n## Hockey\n\nsports guide hockey match puck arena edited\n');
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(f, future, future);
    const { stderr } = await captureStderr(async () => {
      const res = await search({ indexDir: idx, cacheDir: dir, query: 'hockey', k: 3, embedFn: fakeEmbed });
      assert.ok(res.length > 0, 'results still returned on a stale index');
      return res;
    });
    assert.match(stderr, /warning: index is .* older than the newest change in .*mdss-search-/);
    assert.match(stderr, /mdss index/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: fresh index produces no stale warning (issue #20)', async () => {
  const { dir, idx } = await makeIndex();
  try {
    const chunks = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { chunks.push(String(s)); return true; };
    let loaded;
    try {
      loaded = loadIndex(idx);
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(loaded.index, 'fresh index loads fine');
    assert.ok(!chunks.some(c => /older than the newest change/.test(c)),
      'no stale warning on a fresh index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

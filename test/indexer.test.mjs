import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildIndex, chunkHash } from '../src/indexer.mjs';
import { searchIndex, loadIndex } from '../src/search.mjs';
import { resolveModel } from '../src/models.mjs';
import { decodeVec, SCHEMA_VERSION } from '../src/core.mjs';
import { _lexicalStats, validateLexicalIndex } from '../src/lexical.mjs';

/** Deterministic fake embed: bag-of-hash 8d, L2-normalized. No model, no network. */
function fakeEmbed(texts, kind, model, cacheDir) {
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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function writeCorpus(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readIndex(indexDir) {
  return JSON.parse(fs.readFileSync(path.join(indexDir, 'vectors.json'), 'utf8'));
}

const sec = (name, body) => `## ${name}\n\n${body}`;
const big = (n) => 'w'.repeat(n);
const sections = (count, prefix = 'Entry') => Array.from(
  { length: count },
  (_, i) => sec(`${prefix} ${i + 1}`, `${prefix.toLowerCase()}-${i + 1} ${big(40)}`),
).join('\n');

test('chunkHash: stable for identical input; differs on content/model changes', () => {
  const model = resolveModel('e5-base');
  const chunk = { title: 'T', heading: 'H', headingPath: ['T', 'H'], text: 'body text here' };

  const a = chunkHash(model, chunk);
  const b = chunkHash(model, { ...chunk });
  assert.equal(a, b, 'identical input → identical hash');
  const expected = crypto.createHash('sha256').update([
    'heading-path-v1', model.id, 'main', model.passagePrefix, 'T\nH\nbody text here',
  ].join('\u0000')).digest('hex');
  assert.equal(a, expected, 'hash contains the domain, model identity, prefix, and exact passage');

  // CRLF → LF, whitespace-only edges must not change the hash
  const crlf = chunkHash(model, {
    title: 'T\r\n', heading: ' H ', headingPath: [' T ', ' H\r\n'], text: '  body text here\r\n',
  });
  assert.equal(a, crlf, 'CRLF/whitespace normalization');

  const changed = chunkHash(model, { ...chunk, text: 'other text' });
  assert.notEqual(a, changed, 'changed text → different hash');

  const otherModel = resolveModel('e5-small');
  const other = chunkHash(otherModel, chunk);
  assert.notEqual(a, other, 'different model id → different hash');

  const noPrefix = chunkHash({ ...model, passagePrefix: '' }, chunk);
  assert.notEqual(a, noPrefix, 'different passage prefix → different hash');
});

test('chunkHash: pinned revision is part of the key (issue #27)', () => {
  const base = resolveModel('Xenova/multilingual-e5-small');
  const revA = { ...base, revision: 'abc123' };
  const revB = { ...base, revision: 'def456' };
  const chunk = { title: 'T', heading: 'H', headingPath: ['T', 'H'], text: 'body' };

  const a = chunkHash(revA, chunk);
  const b = chunkHash(revB, chunk);
  assert.notEqual(a, b, 'different pinned revisions → different hash');

  // explicit @rev vs default "main" must differ too (the old revision-less
  // hashes would silently collide with any pin)
  const plain = chunkHash(base, chunk);
  assert.notEqual(a, plain, 'pinned revision differs from unpinned ("main") hash');
});

test('chunkHash: does NOT depend on the CLI model alias (issue #6)', () => {
  const model = resolveModel('e5-base');
  const chunk = { title: 'T', heading: 'H', headingPath: ['T', 'H'], text: 'body text here' };

  // Same resolved model descriptor regardless of how the user spelled the name.
  const alias = chunkHash(model, chunk);
  const viaRawId = chunkHash(resolveModel('Xenova/multilingual-e5-base'), chunk);
  assert.equal(alias, viaRawId, 'alias and raw id hash identically');

  // Explicitly: whatever alias string is passed must not leak into the hash.
  const key0 = chunkHash(model, chunk);
  const key1 = chunkHash({ ...model }, chunk); // no alias field at all
  assert.equal(key0, key1);
});

test('chunkHash: ancestor heading changes invalidate the canonical passage hash', () => {
  const model = resolveModel('e5-base');
  const base = { title: 'Doc', heading: 'Leaf', headingPath: ['Doc', 'Parent', 'Leaf'], text: 'body' };

  assert.notEqual(
    chunkHash(model, base),
    chunkHash(model, { ...base, headingPath: ['Doc', 'Renamed parent', 'Leaf'] }),
  );
});

test('buildIndex: exact embed passage deduplicates only a title-derived first H1 path segment', async () => {
  const dir = tempDir('passage');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': '# Same title\n\n## Leaf\n\nbody content long enough for indexing',
      'b.md': '---\ntitle: Frontmatter title\n---\n\n# Different H1\n\n## Leaf\n\nother body content long enough for indexing',
    });
    const passages = [];
    const capture = (texts, kind, model, cacheDir) => {
      passages.push(...texts);
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: capture });

    assert.deepEqual(passages, [
      'Same title\nLeaf\nbody content long enough for indexing',
      'Frontmatter title\nDifferent H1 > Leaf\nother body content long enough for indexing',
    ]);
    assert.deepEqual(readIndex(idx).chunks.map((chunk) => chunk.headingPath), [
      ['Same title', 'Leaf'],
      ['Different H1', 'Leaf'],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: lexical identity prevents chunkHash collision from reusing different TF', async () => {
  const dir = tempDir('lexical-collision');
  const idx = path.join(dir, '.mdss');
  const body = 'shared body content long enough for a chunk';
  try {
    writeCorpus(dir, { 'doc.md': `# Old\n\n${body}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const first = readIndex(idx);
    const forcedCollision = chunkHash(resolveModel('e5-base'), {
      title: 'New', heading: 'New', headingPath: ['New'], text: body,
    });
    first.chunks[0].chunkHash = forcedCollision;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(first));
    writeCorpus(dir, { 'doc.md': `# New\n\n${body}` });
    const before = _lexicalStats.documentsAnalyzed;

    const rebuilt = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const current = readIndex(idx);

    assert.equal(rebuilt.reusedChunks, 1, 'canonical embedding passage still reuses its vector');
    assert.equal(current.chunks[0].chunkHash, forcedCollision, 'the forced vector identity collision is real');
    assert.equal(_lexicalStats.documentsAnalyzed - before, 1, 'different lexical input is analyzed');
    assert.deepEqual(current.lexical.postings.new, [[0, 2]], 'new title/leaf frequencies replace the old record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: first run embeds everything; no-op run reuses everything', async () => {
  const dir = tempDir('init');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}`,
      'b.md': `# B\n\n${sec('Three', big(40))}`,
    });

    const beforeFirst = _lexicalStats.documentsAnalyzed;
    const first = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(first.files, 2);
    assert.equal(first.embedded, first.chunks, 'first run embeds all chunks');
    assert.equal(first.reused, 0);
    assert.ok(first.dim > 0);
    assert.equal(_lexicalStats.documentsAnalyzed - beforeFirst, first.chunks);
    assert.equal(validateLexicalIndex(readIndex(idx).lexical, first.chunks), null);

    const beforeSecond = _lexicalStats.documentsAnalyzed;
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.embedded, 0, 'no-op run embeds nothing');
    assert.equal(second.reused, second.chunks);
    assert.equal(second.reusedChunks, 0, 'no-op goes through file-level fast path');
    assert.equal(second.reusedFiles, second.chunks);
    assert.equal(_lexicalStats.documentsAnalyzed, beforeSecond, 'no-op lexically analyzes zero documents');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: schema-v1 canonical and checkpoint rebuild once without legacy vector reuse', async () => {
  const dir = tempDir('schema-v2-upgrade');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const hashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    const legacy = readIndex(idx);
    legacy.schemaVersion = 1;
    for (const chunk of legacy.chunks) delete chunk.headingPath;
    const legacyBytes = JSON.stringify(legacy);
    fs.writeFileSync(path.join(idx, 'vectors.json'), legacyBytes);
    fs.writeFileSync(checkpointPath, JSON.stringify({ ...legacy, complete: true, hashes }));

    await assert.rejects(
      buildIndex({
        db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base',
        embedFn: () => { throw new Error('stop schema upgrade'); },
      }),
      /stop schema upgrade/,
    );
    assert.equal(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'), legacyBytes,
      'an interrupted v2 rebuild leaves the searchable v1 canonical generation unchanged');

    const upgraded = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    assert.equal(upgraded.embedded, upgraded.chunks, 'v1 vectors are never reused for contextual passages');
    assert.equal(upgraded.reused, 0);
    assert.equal(readIndex(idx).schemaVersion, SCHEMA_VERSION);
    assert.ok(readIndex(idx).chunks.every((chunk) => Array.isArray(chunk.headingPath)));
    const noop = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(noop.embedded, 0, 'the completed v2 generation reuses on the next run');
    assert.equal(noop.reused, noop.chunks);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: schema-v2 rebuild reuses vectors and writes an honest v3 lexical index', async () => {
  const dir = tempDir('schema-v3-upgrade');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const v2 = readIndex(idx);
    v2.schemaVersion = 2;
    delete v2.lexical;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(v2));
    const before = _lexicalStats.documentsAnalyzed;

    const upgraded = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base',
      embedFn: () => { throw new Error('v2 vectors must be reused'); },
    });

    assert.equal(upgraded.embedded, 0);
    assert.equal(upgraded.reused, upgraded.chunks);
    assert.equal(_lexicalStats.documentsAnalyzed - before, upgraded.chunks);
    const current = readIndex(idx);
    assert.equal(current.schemaVersion, 3);
    assert.equal(validateLexicalIndex(current.lexical, current.chunks.length), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: unchanged headingless schema-v2 file is reparsed while its contextual vector is reused', async () => {
  const dir = tempDir('schema-v3-headingless-upgrade');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'plain.md': 'headingless body content long enough for indexing and reuse' });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const v2 = readIndex(idx);
    v2.schemaVersion = 2;
    delete v2.lexical;
    v2.chunks[0].heading = '';
    v2.chunks[0].headingPath = [];
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(v2));

    const upgraded = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base',
      embedFn: () => { throw new Error('valid contextual vector must be reused'); },
    });
    const current = readIndex(idx);

    assert.equal(upgraded.embedded, 0);
    assert.equal(upgraded.reusedChunks, 1, 'v2 migration uses chunkHash reuse after reparsing');
    assert.equal(current.chunks[0].heading, 'plain');
    assert.deepEqual(current.chunks[0].headingPath, ['plain']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: corrupt canonical v3 lexical data reuses vectors and repairs postings', async () => {
  const dir = tempDir('lexical-repair');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('One', 'needle ' + big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const corrupt = readIndex(idx);
    corrupt.lexical.documentLengths = [];
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(corrupt));
    const before = _lexicalStats.documentsAnalyzed;

    const repaired = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base',
      embedFn: () => { throw new Error('valid vectors must be reused'); },
    });

    assert.equal(repaired.embedded, 0);
    assert.equal(repaired.reused, repaired.chunks);
    assert.equal(_lexicalStats.documentsAnalyzed - before, repaired.chunks);
    assert.equal(validateLexicalIndex(readIndex(idx).lexical, repaired.chunks), null);
    assert.deepEqual(Object.keys(loadIndex(idx)).sort(), ['index', 'model']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: append to a file re-embeds only the new section', async () => {
  const dir = tempDir('append');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'log.md': `# Log\n\n${sec('Entry 1', big(40))}\n${sec('Entry 2', big(40))}` });
    const first = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(first.chunks, 2);

    // append a third section to the same file
    fs.appendFileSync(path.join(dir, 'log.md'), `\n${sec('Entry 3', big(40))}`);

    const beforeAppend = _lexicalStats.documentsAnalyzed;
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.chunks, 3);
    assert.equal(second.embedded, 1, 'only the appended section is embedded');
    assert.equal(second.reusedChunks, 2, 'unchanged sections reuse vectors chunk-level');
    assert.equal(_lexicalStats.documentsAnalyzed - beforeAppend, 1, 'only the appended chunk is analyzed');

    const third = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(third.embedded, 0, 'now fully cached');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: editing one section reuses the untouched neighbours', async () => {
  const dir = tempDir('edit');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'doc.md': `# D\n\n${sec('A', big(40))}\n${sec('B', big(40))}\n${sec('C', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    writeCorpus(dir, { 'doc.md': `# D\n\n${sec('A', big(40))}\n${sec('B', big(40) + ' CHANGED')}\n${sec('C', big(40))}` });
    const beforeEdit = _lexicalStats.documentsAnalyzed;
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    assert.equal(res.embedded, 1, 'only the edited section re-embedded');
    assert.equal(res.reusedChunks, 2, 'A and C reused via chunk cache');
    assert.equal(_lexicalStats.documentsAnalyzed - beforeEdit, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: renaming a parent re-embeds only its subtree and reuses a sibling subtree', async () => {
  const dir = tempDir('parent-rename');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'doc.md': `# Doc\n\n## Parent\n\n### Child\n\n${big(40)}\n\n## Sibling\n\n### Cousin\n\n${big(40)}`,
    });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    writeCorpus(dir, {
      'doc.md': `# Doc\n\n## Renamed parent\n\n### Child\n\n${big(40)}\n\n## Sibling\n\n### Cousin\n\n${big(40)}`,
    });

    const beforeRename = _lexicalStats.documentsAnalyzed;
    const result = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    assert.equal(result.embedded, 1);
    assert.equal(result.reusedChunks, 1);
    assert.deepEqual(readIndex(idx).chunks.map((chunk) => chunk.headingPath), [
      ['Doc', 'Renamed parent', 'Child'],
      ['Doc', 'Sibling', 'Cousin'],
    ]);
    assert.equal(_lexicalStats.documentsAnalyzed, beforeRename,
      'parent-only headingPath changes do not alter lexical documents');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: model switch plus file edit reuses unaffected lexical documents', async () => {
  const dir = tempDir('lexical-model-edit');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('Stable', big(40))}\n${sec('Changed', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('Stable', big(40))}\n${sec('Changed', big(40) + ' edited')}` });
    const before = _lexicalStats.documentsAnalyzed;

    const rebuilt = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-small', embedFn: fakeEmbed });

    assert.equal(rebuilt.embedded, 2, 'model switch re-embeds every vector');
    assert.equal(_lexicalStats.documentsAnalyzed - before, 1,
      'only the lexically changed chunk is analyzed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: model switch forces full rebuild', async () => {
  const dir = tempDir('model');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const beforeSwitch = _lexicalStats.documentsAnalyzed;
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-small', embedFn: fakeEmbed });
    assert.equal(res.reused, 0, 'no reuse across models');
    assert.equal(res.embedded, res.chunks, 'everything re-embedded');
    const idx2 = readIndex(idx);
    assert.equal(idx2.model, 'Xenova/multilingual-e5-small@main', 'model identity includes @main (issue #27)');
    assert.equal(_lexicalStats.documentsAnalyzed, beforeSwitch, 'model-only changes reuse lexical analysis');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: known dimensions are enforced while custom model dimensions are learned', async () => {
  const dir = tempDir('embed-dimension');
  const knownIdx = path.join(dir, '.known');
  const customIdx = path.join(dir, '.custom');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    await assert.rejects(
      buildIndex({ db: dir, indexDir: knownIdx, cacheDir: dir, modelName: 'e5-base',
        embedFn: (texts) => texts.map(() => [1, 0, 0]) }),
      /invalid vectors \(expected 768 dims\).*mdss index/i,
    );
    assert.equal(fs.existsSync(path.join(knownIdx, 'vectors.json')), false);

    const custom = await buildIndex({
      db: dir, indexDir: customIdx, cacheDir: dir, modelName: 'Xenova/custom-model',
      embedFn: (texts) => texts.map(() => [1, 0, 0]),
    });
    assert.equal(custom.dim, 3);
    assert.equal(loadIndex(customIdx).index.dim, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: mixed custom dimensions in the first batch fail before canonical publication', async () => {
  const dir = tempDir('mixed-custom-dimension');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}`,
    });
    await assert.rejects(
      buildIndex({
        db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/reviewer-custom-model',
        embedFn: () => [[1, 0], [1, 0, 0]],
      }),
      /invalid vectors \(expected 2 dims\).*mdss index/i,
    );
    assert.equal(fs.existsSync(path.join(idx, 'vectors.json')), false);
    assert.equal(fs.existsSync(path.join(idx, '.hashes.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: custom dimension remains fixed across later batches', async () => {
  const dir = tempDir('later-custom-dimension');
  const idx = path.join(dir, '.mdss');
  let calls = 0;
  try {
    writeCorpus(dir, { 'many.md': `# Many\n\n${sections(33)}` });
    await assert.rejects(
      buildIndex({
        db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/reviewer-custom-model',
        embedFn: (texts) => {
          calls++;
          return texts.map(() => calls === 1 ? [1, 0] : [1, 0, 0]);
        },
      }),
      /invalid vectors \(expected 2 dims\).*mdss index/i,
    );
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(idx, 'vectors.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: inconsistent reused custom vectors are re-embedded before publication', async () => {
  const dir = tempDir('reused-custom-dimension');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'Xenova/reviewer-custom-model', embedFn: (texts) => texts.map(() => [1, 0]) });
    const legacy = readIndex(idx);
    legacy.schemaVersion = 2;
    delete legacy.lexical;
    legacy.chunks[1].vec = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(legacy));

    const rebuilt = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir,
      modelName: 'Xenova/reviewer-custom-model', embedFn: (texts) => texts.map(() => [1, 0]) });
    assert.equal(rebuilt.reused, 1);
    assert.equal(rebuilt.embedded, 1);
    assert.equal(rebuilt.dim, 2);
    assert.equal(loadIndex(idx).index.dim, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: canonical raw known model ids enforce registry dimensions', async () => {
  const dir = tempDir('raw-known-dimension');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    for (const modelName of [
      'Xenova/multilingual-e5-base',
      'Xenova/multilingual-e5-base@review47',
    ]) {
      await assert.rejects(
        buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName,
          embedFn: (texts) => texts.map(() => [1, 0, 0]) }),
        /invalid vectors \(expected 768 dims\).*mdss index/i,
        modelName,
      );
      assert.equal(fs.existsSync(path.join(idx, 'vectors.json')), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: pinned revision bump forces full rebuild (issue #27)', async () => {
  const dir = tempDir('rev');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });

    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/multilingual-e5-small@abc123', embedFn: fakeEmbed });
    const beforeRevision = _lexicalStats.documentsAnalyzed;
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/multilingual-e5-small@def456', embedFn: fakeEmbed });
    assert.equal(res.reused, 0, 'no reuse across pinned revisions');
    assert.equal(res.embedded, res.chunks, 'full rebuild after @revision bump');
    const idx2 = readIndex(idx);
    assert.equal(idx2.model, 'Xenova/multilingual-e5-small@def456', 'stored model carries the new revision');
    assert.equal(_lexicalStats.documentsAnalyzed, beforeRevision, 'revision-only changes reuse lexical analysis');

    // and a same-revision no-op run still reuses everything
    const noop = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/multilingual-e5-small@def456', embedFn: fakeEmbed });
    assert.equal(noop.reused, noop.chunks, 'same revision reuses via fast path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: deleted files drop their chunks', async () => {
  const dir = tempDir('del');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'keep.md': `# K\n\n${sec('One', big(40))}`, 'gone.md': `# G\n\n${sec('Two', big(40))}` });
    const first = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(first.chunks, 2);

    fs.rmSync(path.join(dir, 'gone.md'));
    const beforeDelete = _lexicalStats.documentsAnalyzed;
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.chunks, 1, 'chunks of removed file dropped');
    const files = readIndex(idx).chunks.map((c) => c.file);
    assert.deepEqual(files, ['keep.md']);
    assert.equal(validateLexicalIndex(readIndex(idx).lexical, 1), null);
    assert.equal(_lexicalStats.documentsAnalyzed, beforeDelete, 'deletion analyzes no surviving documents');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: backfills chunkHash into schema-v2 chunks without re-embedding', async () => {
  const dir = tempDir('legacy');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // Schema v2 has contextual passages but predates mandatory v3 metadata.
    const index = readIndex(idx);
    index.schemaVersion = 2;
    delete index.lexical;
    for (const c of index.chunks) delete c.chunkHash;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.embedded, 0, 'current-schema chunks reused, nothing re-embedded');
    assert.equal(res.reused, 2, 'file-level fast path');
    const migrated = readIndex(idx);
    assert.ok(migrated.chunks.every((c) => typeof c.chunkHash === 'string' && c.chunkHash.length === 64),
      'chunkHash backfilled for all chunks');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: ignore globs exclude files from indexing', async () => {
  const dir = tempDir('ignore');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': `# A\n\n${sec('One', big(40))}`,
      'log.md': `# L\n\n${sec('Two', big(40))}`,
    });
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', ignore: ['log.md'], embedFn: fakeEmbed });
    assert.equal(res.files, 1);
    assert.equal(readIndex(idx).chunks[0].file, 'a.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: writes binary vector format (issue #4)', async () => {
  const dir = tempDir('binary');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const index = readIndex(idx);
    assert.equal(index.format, 'binary-v1', 'new indexes carry the binary format marker');
    assert.ok(index.chunks.length > 0);
    for (const c of index.chunks) {
      assert.equal(typeof c.vec, 'string', 'vec stored as base64 string, not decimal array');
      assert.ok(!c.vec.includes('.'), 'no decimal points → not a decimal array');
    }

    // incremental run on the binary index still reuses everything
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.embedded, 0, 'binary index reused without re-embedding');
    assert.equal(second.reused, second.chunks);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: reads schema-v2 decimal vectors.json without re-indexing (issue #4)', async () => {
  const dir = tempDir('legacyvec');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // convert the binary index back to the legacy ≤0.3.x shape: decimal arrays, no format field
    const index = readIndex(idx);
    index.schemaVersion = 2;
    delete index.lexical;
    delete index.format;
    for (const c of index.chunks) c.vec = [...decodeVec(c.vec)];
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.embedded, 0, 'current-schema decimal vectors reused, nothing re-embedded');
    assert.equal(res.reused, 2, 'file-level fast path');
    const migrated = readIndex(idx);
    assert.equal(migrated.format, 'binary-v1', 'legacy index migrated to binary on rewrite');
    assert.ok(migrated.chunks.every((c) => typeof c.vec === 'string'), 'all vecs rewritten as base64');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: legacy chunks with empty vec are re-embedded, search works (issues #25, #28)', async () => {
  const dir = tempDir('novec');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))} needle` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // simulate a v0.1.x index where chunks had no vec at all
    const index = readIndex(idx);
    index.schemaVersion = 1;
    delete index.lexical;
    delete index.format;
    for (const c of index.chunks) delete c.vec;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.embedded, 1, 'vec-less legacy chunk is re-embedded, not reused as-is');
    assert.equal(res.reused, 0, 'nothing reused via the broken fast path');
    const migrated = readIndex(idx);
    assert.ok(typeof migrated.chunks[0].vec === 'string', 'vec rewritten as base64');

    // the repaired index must actually serve searches (issue #25 regression)
    const hits = await searchIndex({
      loaded: loadIndex(idx),
      cacheDir: dir,
      query: 'needle',
      k: 3,
      embedFn: fakeEmbed, // deterministic vectors for the query too
    });
    assert.equal(hits.length, 1, 'search returns the repaired chunk, no TypeError');
    assert.ok(hits[0].file.endsWith('a.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: corrupt vectors.json triggers a warning and rebuilds from scratch', async () => {
  const dir = tempDir('corrupt');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // simulate a torn write: garbage in vectors.json, valid hashes
    fs.writeFileSync(path.join(idx, 'vectors.json'), '{not valid json!!');

    const logs = [];
    const res = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed,
      log: s => logs.push(s),
    });
    assert.ok(logs.some(l => l.includes('not valid JSON')), 'warns about corrupt index');
    assert.equal(res.embedded, 1, 'everything re-embedded after corruption');
    assert.equal(readIndex(idx).chunks.length, 1, 'index rebuilt and readable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: atomic write leaves no temp files behind', async () => {
  const dir = tempDir('atomic');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const leftovers = fs.readdirSync(idx).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'no .tmp files survive an index run');
    assert.ok(fs.existsSync(path.join(idx, 'vectors.json')));
    assert.ok(fs.existsSync(path.join(idx, '.hashes.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: interrupted fresh build resumes from the periodic checkpoint (issue #38)', async () => {
  const dir = tempDir('checkpoint-fresh');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: nine full embedding batches and an embedder that fails on batch 9.
    writeCorpus(dir, { 'many.md': `# Many\n\n${sections(9 * 32)}` });
    let calls = 0;
    const failOnNinthBatch = (texts, kind, model, cacheDir) => {
      calls++;
      if (calls === 9) throw new Error('simulated interruption');
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: the fresh build is interrupted after eight completed batches.
    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: failOnNinthBatch }),
      /simulated interruption/,
    );

    // Then: only the sidecar contains progress; no searchable generation was published.
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.equal(checkpoint.complete, false);
    assert.equal(checkpoint.schemaVersion, SCHEMA_VERSION);
    assert.equal(checkpoint.format, 'binary-v1');
    assert.equal(checkpoint.model, 'Xenova/multilingual-e5-base@main');
    assert.equal(checkpoint.modelAlias, 'e5-base');
    assert.equal(checkpoint.dim, 768);
    assert.equal(checkpoint.db, dir);
    assert.equal(typeof checkpoint.built, 'string');
    assert.equal(checkpoint.chunkCount, 9 * 32);
    assert.deepEqual(Object.keys(checkpoint.hashes), ['many.md']);
    assert.equal(checkpoint.chunks.length, 9 * 32);
    assert.equal(checkpoint.chunks.filter((chunk) => typeof chunk.vec === 'string').length, 8 * 32);
    assert.equal(checkpoint.chunks.filter((chunk) => chunk.vec === undefined).length, 32);
    assert.equal(validateLexicalIndex(checkpoint.lexical, checkpoint.chunks.length), null);
    assert.ok(checkpoint.chunks.slice(0, 8 * 32).every((chunk) => typeof chunk.vec === 'string'));
    assert.ok(checkpoint.chunks.slice(8 * 32).every((chunk) => chunk.vec === undefined));
    assert.equal(fs.existsSync(path.join(idx, 'vectors.json')), false);
    assert.equal(fs.existsSync(path.join(idx, '.hashes.json')), false);
    assert.deepEqual(fs.readdirSync(idx).filter((file) => file.includes('.tmp')), []);

    let resumedTexts = 0;
    const countResumed = (texts, kind, model, cacheDir) => {
      resumedTexts += texts.length;
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: a second build resumes with the same corpus and model.
    const resumed = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: countResumed,
    });

    // Then: only unfinished chunks are embedded and the checkpoint is removed.
    assert.equal(resumedTexts, 32);
    assert.equal(resumed.embedded, 32);
    assert.ok(readIndex(idx).chunks.every((chunk) => typeof chunk.vec === 'string'));
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: failed refresh preserves canonical generation and resumes its checkpoint (issue #38)', async () => {
  const dir = tempDir('checkpoint-refresh');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: a complete searchable generation, then 288 new chunks to refresh.
    writeCorpus(dir, { 'doc.md': `# Stable\n\n${sec('Original', 'stable needle ' + big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const canonicalVectors = fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8');
    const canonicalHashes = fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8');
    writeCorpus(dir, {
      'doc.md': `# Stable\n\n${sec('Original', 'stable needle ' + big(40))}\n${sections(9 * 32, 'New')}`,
    });
    let calls = 0;
    const failOnNinthBatch = (texts, kind, model, cacheDir) => {
      calls++;
      if (calls === 9) throw new Error('simulated refresh interruption');
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: refresh fails after its first checkpoint has been persisted.
    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: failOnNinthBatch }),
      /simulated refresh interruption/,
    );

    // Then: canonical files are byte-for-byte unchanged and remain searchable.
    assert.equal(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'), canonicalVectors);
    assert.equal(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'), canonicalHashes);
    const hits = await searchIndex({
      loaded: loadIndex(idx), cacheDir: dir, query: 'stable needle', k: 1, embedFn: fakeEmbed,
    });
    assert.equal(hits[0].heading, 'Original');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.equal(checkpoint.complete, false);
    assert.equal(checkpoint.chunks.length, 1 + 9 * 32);
    assert.equal(checkpoint.chunks.filter((chunk) => typeof chunk.vec === 'string').length, 1 + 8 * 32);
    assert.ok(checkpoint.chunks.slice(0, 1 + 8 * 32).every((chunk) => typeof chunk.vec === 'string'));
    assert.ok(checkpoint.chunks.slice(1 + 8 * 32).every((chunk) => chunk.vec === undefined));

    let resumedTexts = 0;
    const countResumed = (texts, kind, model, cacheDir) => {
      resumedTexts += texts.length;
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: refresh retries from the compatible checkpoint.
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: countResumed });

    // Then: only the final batch is embedded and the complete generation replaces canonical files.
    assert.equal(resumedTexts, 32);
    assert.equal(readIndex(idx).chunks.length, 1 + 9 * 32);
    assert.ok(readIndex(idx).chunks.every((chunk) => typeof chunk.vec === 'string'));
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: checkpoint resume reparses corpus changes and reuses only finished chunk hashes (issue #38)', async () => {
  const dir = tempDir('checkpoint-reparse');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: a partial checkpoint with 256 finished and 32 unfinished chunks.
    writeCorpus(dir, { 'many.md': `# Many\n\n${sections(9 * 32)}` });
    let batch = 0;
    const interruptNinthBatch = (texts, kind, model, cacheDir) => {
      batch++;
      if (batch === 9) throw new Error('simulated interruption before corpus edit');
      return fakeEmbed(texts, kind, model, cacheDir);
    };
    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: interruptNinthBatch }),
      /simulated interruption before corpus edit/,
    );
    assert.ok(fs.existsSync(checkpointPath));
    writeCorpus(dir, {
      'many.md': [
        '# Many',
        sec('Entry 1', `entry-1 ${big(40)}`),
        sec('Entry 2', `entry-2 changed ${big(40)}`),
        sec('Entry 257', `entry-257 ${big(40)}`),
        sec('Added', `brand-new ${big(40)}`),
      ].join('\n\n'),
    });
    const embeddedTexts = [];
    const captureEmbeds = (texts, kind, model, cacheDir) => {
      embeddedTexts.push(...texts);
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: the build resumes after the corpus md5 has changed.
    const resumed = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: captureEmbeds,
    });

    // Then: current content is reparsed, one finished hash is reused, and all other current chunks embed.
    assert.equal(resumed.chunks, 4);
    assert.equal(resumed.reusedChunks, 1);
    assert.equal(resumed.embedded, 3);
    assert.deepEqual(embeddedTexts.map((text) => text.split('\n')[1]), ['Entry 2', 'Entry 257', 'Added']);
    const current = readIndex(idx);
    assert.deepEqual(current.chunks.map((chunk) => chunk.heading), ['Entry 1', 'Entry 2', 'Entry 257', 'Added']);
    assert.ok(current.chunks[1].text.includes('changed'));
    assert.ok(current.chunks.every((chunk) => typeof chunk.vec === 'string'));
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: complete checkpoint repairs a torn canonical pair without embedding (issue #38)', async () => {
  const dir = tempDir('checkpoint-complete');
  const idx = path.join(dir, '.mdss');
  const newerIdx = path.join(dir, '.newer-mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: old canonical vectors, newer canonical hashes, and a self-contained newer complete checkpoint.
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('Old', `old generation ${big(40)}`)}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const oldVectors = fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8');
    writeCorpus(dir, {
      'doc.md': `# Doc\n\n${sec('Current A', `current alpha ${big(40)}`)}\n${sec('Current B', `current beta ${big(40)}`)}`,
    });
    await buildIndex({ db: dir, indexDir: newerIdx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const newerIndex = readIndex(newerIdx);
    const newerHashes = JSON.parse(fs.readFileSync(path.join(newerIdx, '.hashes.json'), 'utf8'));
    fs.writeFileSync(path.join(idx, 'vectors.json'), oldVectors);
    fs.writeFileSync(path.join(idx, '.hashes.json'), JSON.stringify(newerHashes, null, 2));
    fs.writeFileSync(checkpointPath, JSON.stringify({ ...newerIndex, complete: true, hashes: newerHashes }));
    let embedCalls = 0;
    const rejectUnnecessaryEmbed = (texts, kind, model, cacheDir) => {
      embedCalls++;
      return fakeEmbed(texts, kind, model, cacheDir);
    };

    // When: the next build sees the compatible complete checkpoint and torn canonical pair.
    const recovered = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: rejectUnnecessaryEmbed,
    });

    // Then: the checkpoint republishes a matched full generation without unnecessary embedding.
    assert.equal(embedCalls, 0);
    assert.equal(recovered.embedded, 0);
    assert.equal(recovered.reused, newerIndex.chunks.length);
    const canonical = readIndex(idx);
    const canonicalHashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    assert.deepEqual(canonical.chunks, newerIndex.chunks);
    assert.deepEqual(canonicalHashes, newerHashes);
    assert.ok(canonical.chunks.every((chunk) => typeof chunk.vec === 'string'));
    assert.equal(fs.existsSync(checkpointPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: future canonical schema rejects rebuild despite a compatible checkpoint (issues #38, #39)', async () => {
  const dir = tempDir('checkpoint-future-schema');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: a current compatible checkpoint beside canonical bytes from a future schema.
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('Current', `current generation ${big(40)}`)}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const current = readIndex(idx);
    const hashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    fs.writeFileSync(checkpointPath, JSON.stringify({ ...current, complete: true, hashes }));
    const futureBytes = JSON.stringify({ ...current, schemaVersion: current.schemaVersion + 1 });
    fs.writeFileSync(path.join(idx, 'vectors.json'), futureBytes);

    // When: rebuild is attempted with a sidecar that the current binary understands.
    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed }),
      /uses schema v\d+.*upgrade md-semantic-search before re-indexing/,
    );

    // Then: the future canonical generation is authoritative and remains untouched.
    assert.equal(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'), futureBytes);
    assert.equal(fs.existsSync(checkpointPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: future schema remains authoritative when chunks are malformed', async () => {
  const dir = tempDir('future-malformed');
  const idx = path.join(dir, '.mdss');
  const vectorsPath = path.join(idx, 'vectors.json');
  try {
    fs.mkdirSync(idx, { recursive: true });
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}` });
    fs.writeFileSync(vectorsPath, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, chunks: null }));

    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed }),
      /uses schema v4.*upgrade md-semantic-search before re-indexing/i,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(vectorsPath, 'utf8')),
      { schemaVersion: SCHEMA_VERSION + 1, chunks: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: malformed or incompatible checkpoints fall back to canonical without embedding (issue #38)', async () => {
  const dir = tempDir('checkpoint-invalid');
  const idx = path.join(dir, '.mdss');
  const checkpointPath = path.join(idx, '.checkpoint.json');
  try {
    // Given: a valid canonical index and sidecars that are malformed or target another build identity.
    writeCorpus(dir, { 'doc.md': `# Doc\n\n${sec('Canonical', `canonical generation ${big(40)}`)}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const canonical = readIndex(idx);
    const hashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    const vectorlessChunks = canonical.chunks.map(({ file, title, heading, headingPath, text, chunkHash }) => ({
      file, title, heading, headingPath, text, chunkHash,
    }));
    const sidecars = [
      {
        name: 'null chunk',
        value: { ...canonical, complete: false, hashes, chunkCount: 1, chunks: [null] },
      },
      {
        name: 'non-string hash value',
        value: { ...canonical, complete: false, hashes: { 'doc.md': 42 }, chunks: vectorlessChunks },
      },
      {
        name: 'wrong db',
        value: { ...canonical, complete: true, hashes, db: `${dir}-other` },
      },
      {
        name: 'wrong model',
        value: { ...canonical, complete: true, hashes, model: 'Xenova/multilingual-e5-small@main' },
      },
      {
        name: 'missing heading path',
        value: { ...canonical, complete: false, hashes, chunks: vectorlessChunks.map(({ headingPath, ...chunk }) => chunk) },
      },
      {
        name: 'non-array heading path',
        value: { ...canonical, complete: false, hashes, chunks: vectorlessChunks.map((chunk) => ({ ...chunk, headingPath: chunk.heading })) },
      },
      {
        name: 'non-string heading path segment',
        value: { ...canonical, complete: false, hashes, chunks: vectorlessChunks.map((chunk) => ({ ...chunk, headingPath: [...(chunk.headingPath ?? [chunk.heading]), 42] })) },
      },
      {
        name: 'blank heading path segment',
        value: { ...canonical, complete: false, hashes, chunks: vectorlessChunks.map((chunk) => ({ ...chunk, headingPath: [' ', ...(chunk.headingPath ?? [chunk.heading])] })) },
      },
      {
        name: 'heading path leaf mismatch',
        value: { ...canonical, complete: false, hashes, chunks: vectorlessChunks.map((chunk) => ({ ...chunk, headingPath: [...(chunk.headingPath ?? [chunk.heading]).slice(0, -1), 'Other'] })) },
      },
      {
        name: 'lexical count mismatch',
        value: { ...canonical, complete: false, hashes, lexical: { ...canonical.lexical, documentLengths: [] } },
      },
      {
        name: 'wrong vector dimension',
        value: {
          ...canonical, complete: true, hashes,
          chunks: canonical.chunks.map((chunk) => ({
            ...chunk, vec: Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64'),
          })),
        },
      },
    ];

    for (const sidecar of sidecars) {
      fs.writeFileSync(checkpointPath, JSON.stringify(sidecar.value));
      let embedCalls = 0;
      const countEmbeds = (texts, kind, model, cacheDir) => {
        embedCalls++;
        return fakeEmbed(texts, kind, model, cacheDir);
      };

      // When: each invalid sidecar is presented to an otherwise no-op build.
      await assert.doesNotReject(
        buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: countEmbeds }),
        sidecar.name,
      );

      // Then: canonical reuse wins, with no model work, and successful publication cleans the sidecar.
      assert.equal(embedCalls, 0, sidecar.name);
      assert.deepEqual(readIndex(idx).chunks.map((chunk) => chunk.heading), ['Canonical'], sidecar.name);
      assert.equal(readIndex(idx).dim, canonical.dim, sidecar.name);
      assert.equal(decodeVec(readIndex(idx).chunks[0].vec, canonical.dim).length, canonical.dim, sidecar.name);
      assert.equal(fs.existsSync(checkpointPath), false, sidecar.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: unreadable file is skipped with a warning, others still indexed (issue #36)', async (t) => {
  const dir = tempDir('skip');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': `# A\n\n${sec('One', big(40))}`,
      'b.md': `# B\n\n${sec('Two', big(40))}`,
    });
    // Create an unreadable .md: a broken symlink (readFileSync → ENOENT) or,
    // when symlinks are unavailable (Windows without privileges), chmod 000.
    const bad = path.join(dir, 'bad.md');
    let unreadable = false;
    try {
      fs.symlinkSync(path.join(dir, 'does-not-exist.md'), bad, 'file');
      unreadable = true; // broken symlink → readFileSync throws ENOENT
    } catch {
      try {
        fs.writeFileSync(bad, '# Bad\n\nx\n');
        fs.chmodSync(bad, 0o000);
        try { fs.readFileSync(bad, 'utf8'); } catch { unreadable = true; } // EACCES
      } catch { /* leave unreadable=false */ }
    }
    if (!unreadable) {
      t.skip('platform cannot create an unreadable file (no symlinks, chmod ignored)');
      return;
    }

    const logs = [];
    const res = await buildIndex({
      db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed,
      log: s => logs.push(s),
    });
    assert.equal(res.files, 3, 'all 3 files walked');
    assert.equal(res.skipped, 1, 'one unreadable file skipped');
    assert.equal(res.chunks, 2, 'two readable files indexed');
    assert.ok(logs.some(l => /warning: skipping .*bad\.md/.test(l)), 'warns about the skipped file');

    // the skipped file is absent from the new index AND its hash record
    const index = readIndex(idx);
    assert.ok(!index.chunks.some(c => c.file === 'bad.md'), 'skipped file has no chunks');
    const hashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    assert.ok(!('bad.md' in hashes), 'skipped file absent from .hashes.json');

    // a second run still reuses the readable files and keeps skipping the bad one
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.skipped, 1, 'still skipped on re-run');
    assert.equal(second.reused, 2, 'readable files reused via fast path');
  } finally {
    // chmod 000 may block rmSync on some platforms — restore before cleanup
    try { fs.chmodSync(path.join(dir, 'bad.md'), 0o644); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

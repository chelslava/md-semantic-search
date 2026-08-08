import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, chunkHash } from '../src/indexer.mjs';
import { resolveModel } from '../src/models.mjs';

/** Deterministic fake embed: bag-of-hash 8d, L2-normalized. No model, no network. */
function fakeEmbed(texts, kind, model, cacheDir) {
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

test('chunkHash: stable for identical input; differs on content/model changes', () => {
  const model = resolveModel('e5-base');
  const chunk = { title: 'T', heading: 'H', text: 'body text here' };

  const a = chunkHash(model, 'e5-base', chunk);
  const b = chunkHash(model, 'e5-base', { ...chunk });
  assert.equal(a, b, 'identical input → identical hash');

  // CRLF → LF, whitespace-only edges must not change the hash
  const crlf = chunkHash(model, 'e5-base', {
    title: 'T\r\n', heading: ' H ', text: '  body text here\r\n',
  });
  assert.equal(a, crlf, 'CRLF/whitespace normalization');

  const changed = chunkHash(model, 'e5-base', { ...chunk, text: 'other text' });
  assert.notEqual(a, changed, 'changed text → different hash');

  const otherModel = resolveModel('e5-small');
  const other = chunkHash(otherModel, 'e5-small', chunk);
  assert.notEqual(a, other, 'different model id → different hash');

  const noPrefix = chunkHash({ ...model, passagePrefix: '' }, 'e5-base', chunk);
  assert.notEqual(a, noPrefix, 'different passage prefix → different hash');
});

test('buildIndex: first run embeds everything; no-op run reuses everything', async () => {
  const dir = tempDir('init');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, {
      'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}`,
      'b.md': `# B\n\n${sec('Three', big(40))}`,
    });

    const first = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(first.files, 2);
    assert.equal(first.embedded, first.chunks, 'first run embeds all chunks');
    assert.equal(first.reused, 0);
    assert.ok(first.dim > 0);

    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.embedded, 0, 'no-op run embeds nothing');
    assert.equal(second.reused, second.chunks);
    assert.equal(second.reusedChunks, 0, 'no-op goes through file-level fast path');
    assert.equal(second.reusedFiles, second.chunks);
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

    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.chunks, 3);
    assert.equal(second.embedded, 1, 'only the appended section is embedded');
    assert.equal(second.reusedChunks, 2, 'unchanged sections reuse vectors chunk-level');

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
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    assert.equal(res.embedded, 1, 'only the edited section re-embedded');
    assert.equal(res.reusedChunks, 2, 'A and C reused via chunk cache');
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

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-small', embedFn: fakeEmbed });
    assert.equal(res.reused, 0, 'no reuse across models');
    assert.equal(res.embedded, res.chunks, 'everything re-embedded');
    const idx2 = readIndex(idx);
    assert.equal(idx2.model, 'Xenova/multilingual-e5-small');
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
    const second = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(second.chunks, 1, 'chunks of removed file dropped');
    const files = readIndex(idx).chunks.map((c) => c.file);
    assert.deepEqual(files, ['keep.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex: backfills chunkHash into legacy chunks without re-embedding', async () => {
  const dir = tempDir('legacy');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // simulate a 0.1.x index: strip chunkHash fields
    const index = readIndex(idx);
    for (const c of index.chunks) delete c.chunkHash;
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.embedded, 0, 'legacy chunks reused, nothing re-embedded');
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

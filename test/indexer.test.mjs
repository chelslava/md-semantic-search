import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, chunkHash } from '../src/indexer.mjs';
import { searchIndex, loadIndex } from '../src/search.mjs';
import { resolveModel } from '../src/models.mjs';
import { decodeVec } from '../src/core.mjs';

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

  const a = chunkHash(model, chunk);
  const b = chunkHash(model, { ...chunk });
  assert.equal(a, b, 'identical input → identical hash');

  // CRLF → LF, whitespace-only edges must not change the hash
  const crlf = chunkHash(model, {
    title: 'T\r\n', heading: ' H ', text: '  body text here\r\n',
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
  const chunk = { title: 'T', heading: 'H', text: 'body' };

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
  const chunk = { title: 'T', heading: 'H', text: 'body text here' };

  // Same resolved model descriptor regardless of how the user spelled the name.
  const alias = chunkHash(model, chunk);
  const viaRawId = chunkHash(resolveModel('Xenova/multilingual-e5-base'), chunk);
  assert.equal(alias, viaRawId, 'alias and raw id hash identically');

  // Explicitly: whatever alias string is passed must not leak into the hash.
  const key0 = chunkHash(model, chunk);
  const key1 = chunkHash({ ...model }, chunk); // no alias field at all
  assert.equal(key0, key1);
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
    assert.equal(idx2.model, 'Xenova/multilingual-e5-small@main', 'model identity includes @main (issue #27)');
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
    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'Xenova/multilingual-e5-small@def456', embedFn: fakeEmbed });
    assert.equal(res.reused, 0, 'no reuse across pinned revisions');
    assert.equal(res.embedded, res.chunks, 'full rebuild after @revision bump');
    const idx2 = readIndex(idx);
    assert.equal(idx2.model, 'Xenova/multilingual-e5-small@def456', 'stored model carries the new revision');

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

test('buildIndex: reads legacy decimal vectors.json without re-indexing (issue #4)', async () => {
  const dir = tempDir('legacyvec');
  const idx = path.join(dir, '.mdss');
  try {
    writeCorpus(dir, { 'a.md': `# A\n\n${sec('One', big(40))}\n${sec('Two', big(40))}` });
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // convert the binary index back to the legacy ≤0.3.x shape: decimal arrays, no format field
    const index = readIndex(idx);
    delete index.format;
    for (const c of index.chunks) c.vec = [...decodeVec(c.vec)];
    fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.embedded, 0, 'legacy decimal vectors reused, nothing re-embedded');
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

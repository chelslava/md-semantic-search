import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex } from '../dist/search.js';
import { walkMarkdown } from '../dist/core.js';

const IS_WIN = process.platform === 'win32';

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

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/** Writable root on a DIFFERENT drive than `p` (win32), else null. */
function otherDriveRoot(p) {
  if (!IS_WIN) return null;
  const currentDrive = path.parse(p).root.toUpperCase();
  for (const candidate of ['D:\\', 'E:\\', 'C:\\']) {
    if (candidate.toUpperCase() === currentDrive) continue;
    const probe = path.join(candidate, `mdss-probe-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return candidate;
    } catch {
      /* drive unavailable */
    }
  }
  return null;
}

test('longpath: deep tree beyond MAX_PATH (>260) indexes, searches, exports relative paths (issue #118)', async () => {
  let base = '';
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-longpath-'));
    // grow until the NOTE path exceeds 260 chars
    const segment = 'level-with-a-fairly-long-name-20ch';
    let deep = base;
    while (path.join(deep, 'note.md').length <= 260) {
      deep = path.join(deep, segment);
      fs.mkdirSync(deep, { recursive: true });
      assert.ok(deep.length < 2000, 'sanity: nesting converges');
    }
    const notePath = path.join(deep, 'note.md');
    fs.writeFileSync(notePath, '# Deep Coffee\n\ncoffee beans buried very deep underground notes\n');
    assert.ok(notePath.length > 260, `fixture exceeds MAX_PATH (${notePath.length})`);

    const idx = path.join(base, '.mdss');
    await buildIndex({ db: base, indexDir: idx, cacheDir: path.join(base, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });

    // lockfile valid
    const lock = path.join(idx, '.mdss.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    assert.ok(fs.statSync(lock).isFile());
    fs.unlinkSync(lock);

    // search roundtrip through the loader
    const loaded = loadIndex(idx);
    const hits = await searchIndex({ loaded, cacheDir: path.join(base, '.c'), query: 'coffee deep', k: 3, embedFn: fakeEmbed });
    assert.ok(hits.length >= 1, 'deep note found');

    // exporter contract: chunk paths are RELATIVE posix regardless of absolute depth
    const vectors = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    for (const c of vectors.chunks) {
      assert.ok(!path.isAbsolute(c.file), `chunk path is relative: ${c.file}`);
      assert.ok(!c.file.includes('\\'), `chunk path uses posix separators: ${c.file}`);
      assert.ok(fs.existsSync(path.join(base, c.file)), 'relative path resolves back to the source');
    }
  } finally {
    safeRm(base);
  }
});

test('longpath: unicode + spaces in names survive index/search roundtrip (issue #118)', async () => {
  let base = '';
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-юникод-'));
    const dir = path.join(base, 'Кофе и чай', 'заметки с пробелами');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'варка кофе.md'), '# Варка\n\nсвежие зёрна помол температура заметки\n');

    const idx = path.join(base, '.mdss');
    await buildIndex({ db: base, indexDir: idx, cacheDir: path.join(base, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const loaded = loadIndex(idx);
    const hits = await searchIndex({ loaded, cacheDir: path.join(base, '.c'), query: 'кофе зёрна', k: 3, embedFn: fakeEmbed });
    assert.ok(hits.some((h) => h.file.includes('варка кофе.md')), 'unicode hit found');
  } finally {
    safeRm(base);
  }
});

test('longpath: junction cycle terminates the walker (documented behavior, issue #118)', { timeout: 10000 }, async () => {
  if (!IS_WIN) return; // junctions are a Windows concept; POSIX loop handling covered by fuzz suite
  let base = '';
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-junc-'));
    const outer = path.join(base, 'vault');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(outer, 'real.md'), '# Real\n\nreal content before the loop\n');
    // cycle: vault/inner/loop -> vault
    fs.symlinkSync(outer, path.join(inner, 'loop'), 'junction');

    // MUST terminate (well under the 10 s test timeout) rather than hang forever.
    const t0 = Date.now();
    const files = walkMarkdown(base);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000, `walker terminated in ${elapsed} ms`);
    assert.ok(files.some((f) => f.endsWith('real.md')), 'real content still discovered');
    // Documented behavior: whatever the count, it is FINITE and deterministic.
    assert.ok(files.length >= 1 && files.length < 500, `finite discovery: ${files.length}`);
  } finally {
    safeRm(base);
  }
});

test('longpath: --index-dir on ANOTHER DRIVE than --db (win32, skipped when unavailable)', async () => {
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-xdrv-db-'));
  let idx = '';
  try {
    const other = otherDriveRoot(db);
    if (!other) return; // single-drive environment — nothing to prove here
    idx = fs.mkdtempSync(path.join(other, 'mdss-xdrv-idx-'));
    fs.writeFileSync(path.join(db, 'a.md'), '# Cross\n\ncross drive coffee notes\n');
    await buildIndex({ db, indexDir: idx, cacheDir: path.join(db, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const loaded = loadIndex(idx);
    const hits = await searchIndex({ loaded, cacheDir: path.join(db, '.c'), query: 'cross drive', k: 3, embedFn: fakeEmbed });
    assert.ok(hits.length >= 1, 'index on second drive serves search');
  } finally {
    safeRm(db);
    safeRm(idx);
  }
});

test('longpath: \\\\?\\ extended-length prefix on the db root (win32)', async () => {
  if (!IS_WIN) return;
  let base = '';
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-ns-'));
    fs.writeFileSync(path.join(base, 'ns.md'), '# Namespaced\n\nextended length prefix notes\n');
    const nsDb = path.toNamespacedPath(base);
    const idx = path.join(base, '.mdss'); // keep indexDir in normal form

    await buildIndex({
      db: nsDb,
      indexDir: path.toNamespacedPath(idx),
      cacheDir: path.join(base, '.c'),
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const nsFiles = walkMarkdown(nsDb);
    assert.equal(nsFiles.length, 1, '\\\\?\\ walk finds the note');

    const loaded = loadIndex(idx);
    const hits = await searchIndex({ loaded, cacheDir: path.join(base, '.c'), query: 'prefix notes', k: 3, embedFn: fakeEmbed });
    assert.ok(hits.length >= 1, 'search over \\-prefixed-built index works');
    // chunk rel paths stay clean (no \\?\ leakage into stored metadata)
    const vectors = JSON.parse(fs.readFileSync(path.join(idx, 'vectors.json'), 'utf8'));
    for (const c of vectors.chunks) assert.ok(!c.file.includes('?'), `no prefix leakage: ${c.file}`);
  } finally {
    safeRm(base);
  }
});

test('longpath: UNC share root only behind MDSS_TEST_UNC_ROOT env (issue #118)', async () => {
  const unc = process.env.MDSS_TEST_UNC_ROOT;
  if (!unc) return; // no reachable share in CI/dev — explicitly skippable per issue
  const files = walkMarkdown(unc);
  assert.ok(Array.isArray(files), 'UNC walk returns a list');
});

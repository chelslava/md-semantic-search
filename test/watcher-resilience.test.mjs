import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildIndex } from '../dist/indexer.js';
import { createServe } from '../dist/serve.js';
import { classifyFsError, readWithRetry } from '../dist/watcher.js';

const realMd5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const errWith = (code, msg) => Object.assign(new Error(msg || code), { code });

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

async function seedWatch() {
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-wres-'));
  const idx = path.join(db, '.mdss');
  fs.writeFileSync(path.join(db, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes\n');
  fs.writeFileSync(path.join(db, 'b.md'), '# Hockey\n\nhockey match puck arena notes\n');
  await buildIndex({ db, indexDir: idx, cacheDir: path.join(db, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
  return { db, idx };
}

test('watcher: classifyFsError buckets codes and messages (issue #116)', () => {
  assert.equal(classifyFsError(errWith('ENOENT')), 'vanished');
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']) {
    assert.equal(classifyFsError(errWith(code)), 'transient', code);
  }
  assert.equal(classifyFsError(new Error('file is being written by pid 42')), 'transient');
  assert.equal(classifyFsError(errWith('EISDIR')), 'permanent');
  assert.equal(classifyFsError(null), 'permanent');
});

test('watcher: readWithRetry retries transient failures, never permanent ones (issue #116)', async () => {
  let attempts = 0;
  const retries = [];
  const r = await readWithRetry(
    () => {
      attempts += 1;
      if (attempts < 3) throw errWith('EBUSY');
      return 'md5value';
    },
    { attempts: 3, baseDelayMs: 1, onRetry: (a, err) => retries.push([a, err.code]) },
  );
  assert.equal(r.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [[1, 'EBUSY'], [2, 'EBUSY']]);

  let permAttempts = 0;
  const p = await readWithRetry(() => {
    permAttempts += 1;
    throw errWith('EISDIR');
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.cls, 'permanent');
  assert.equal(permAttempts, 1, 'permanent errors burn zero retries');
});

test('watcher: transiently locked file lands after the lock clears — exactly once (issue #116)', async () => {
  const { db, idx } = await seedWatch();
  try {
    let lockUntil = Date.now() + 300;
    let injected = 0;
    const srv = await createServe({
      db, indexDir: idx, cacheDir: path.join(db, '.c'), embedFn: fakeEmbed,
      watch: true, watchInterval: 60, watchDelay: 100,
      watchDebug: true,
      _testFs: {
        hash: (f) => {
          if (f.endsWith('b.md') && Date.now() < lockUntil) {
            injected += 1;
            throw errWith('EBUSY');
          }
          return realMd5(f);
        },
      },
      log: () => {},
    });
    await new Promise((r) => srv.server.listen(0, r));
    try {
      fs.appendFileSync(path.join(db, 'b.md'), '\nmore coffee notes\n');
      lockUntil = 0; // unlock right away; the retry path must still land it

      const deadline = Date.now() + 5000;
      while ((srv.state.reindexCount ?? 0) < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(injected >= 1, 'EBUSY injection was exercised');
      assert.equal(srv.state.reindexCount, 1, 'change landed once the lock cleared');

      const text = srv.state.loaded.index.chunks
        .filter((c) => c.file === 'b.md').map((c) => c.text).join('');
      assert.match(text, /more coffee notes/, 'final index contains the edit');
      // several more polls — must stay at exactly one re-index
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(srv.state.reindexCount, 1, 'no infinite pending loop');
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(db);
  }
});

test('watcher: permanent failures warn rate-limited; healthy files keep indexing (issue #116)', async () => {
  const { db, idx } = await seedWatch();
  try {
    const logs = [];
    const srv = await createServe({
      db, indexDir: idx, cacheDir: path.join(db, '.c'), embedFn: fakeEmbed,
      watch: true, watchInterval: 40, watchDelay: 80,
      _testFs: {
        hash: (f) => {
          if (f.endsWith('a.md')) throw errWith('EACCES'); // forever
          return realMd5(f);
        },
      },
      log: (m) => logs.push(String(m)),
    });
    await new Promise((r) => srv.server.listen(0, r));
    try {
      // Each poll cycle carries up to ~600 ms of in-cycle backoff for the
      // broken file (3 x 200 ms per issue #116), so give the first warning
      // window comfortably more than one cycle.
      await new Promise((r) => setTimeout(r, 1800));

      const warns = logs.filter((l) => l.includes('unreadable'));
      assert.ok(warns.length >= 1, 'at least one rate-limited warning issued');
      assert.match(warns[0], /a\.md/, 'affected file named in the warning');

      fs.appendFileSync(path.join(db, 'b.md'), '\nhockey overtime notes\n');
      const deadline = Date.now() + 4000;
      while ((srv.state.reindexCount ?? 0) < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(srv.state.reindexCount, 1, 'healthy files keep flowing around a broken one');
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(db);
  }
});

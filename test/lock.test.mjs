import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireIndexLock, releaseIndexLock, withIndexLock,
  pidAlive, LOCK_FILENAME,
} from '../dist/core.js';
import { buildIndex } from '../dist/indexer.js';

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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

// A pid that is essentially guaranteed dead: our own is alive, so use a very
// large pid + confirm it's really gone (probe it, then it's safe to use as the
// "dead holder" fixture without ever touching a live process).
function aDeadPid() {
  for (let pid = 4_000_000; ; pid++) {
    if (!pidAlive(pid)) return pid;
  }
}

test('lock: acquire succeeds on a free index dir and release frees it', () => {
  const dir = tempDir('lockbasic');
  try {
    const r1 = acquireIndexLock(dir);
    assert.equal(r1.acquired, true, 'fresh dir has no lock — first acquire wins');
    assert.ok(fs.existsSync(path.join(dir, LOCK_FILENAME)), 'lock file written');
    releaseIndexLock(dir);
    assert.ok(!fs.existsSync(path.join(dir, LOCK_FILENAME)), 'release removes the file');
    const r2 = acquireIndexLock(dir);
    assert.equal(r2.acquired, true, 'after release the lock is free again');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a live self-owned lock blocks a second acquisition with a clear reason', () => {
  const dir = tempDir('lockheld');
  try {
    const r1 = acquireIndexLock(dir);
    assert.equal(r1.acquired, true);
    const r2 = acquireIndexLock(dir);
    assert.equal(r2.acquired, false, 'second acquire must NOT take a held lock');
    assert.match(r2.reason, /being written by pid/i, 'reason says who holds it');
    assert.equal(r2.pid, process.pid, 'the blocking pid is ours');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a tombstone from a DEAD pid is reclaimed (crash recovery)', () => {
  const dir = tempDir('lockstale');
  try {
    // Simulate a crashed writer: lock file present, holder pid gone.
    const dead = aDeadPid();
    fs.writeFileSync(path.join(dir, LOCK_FILENAME),
      JSON.stringify({ pid: dead, since: new Date().toISOString() }) + '\n');
    const r = acquireIndexLock(dir);
    assert.equal(r.acquired, true, 'dead-pid lock is reclaimed, not honored');
    // …and the reclaimed lock now names THIS pid, not the dead one.
    const body = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILENAME), 'utf8'));
    assert.equal(body.pid, process.pid, 'reclaimed lock carries the new owner');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: an OLD lock (stale mtime) is reclaimed even if the pid looks alive', () => {
  const dir = tempDir('lockold');
  try {
    fs.writeFileSync(path.join(dir, LOCK_FILENAME),
      JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n');
    // age it past the 10-minute staleness window
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(path.join(dir, LOCK_FILENAME), old, old);
    const r = acquireIndexLock(dir);
    assert.equal(r.acquired, true, 'stale lock is reclaimed');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a garbage lock file (unparsable body) is reclaimed', () => {
  const dir = tempDir('lockgarbage');
  try {
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), '{oops not json');
    const r = acquireIndexLock(dir);
    assert.equal(r.acquired, true, 'garbage lock is treated as abandoned');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: withIndexLock releases the lock even when fn throws', async () => {
  const dir = tempDir('lockthrow');
  try {
    await assert.rejects(
      withIndexLock(dir, async () => { throw new Error('boom'); }),
      /boom/,
      'the inner error propagates',
    );
    assert.ok(!fs.existsSync(path.join(dir, LOCK_FILENAME)),
      'the finally released the lock despite the throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: buildIndex under a held lock fails with an actionable message (issue #37)', async () => {
  const dir = tempDir('lockidx');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground to a fine powder for brewing\n');
    fs.mkdirSync(idx, { recursive: true });
    // Take the lock as a stand-in for another md/index process.
    const held = acquireIndexLock(idx);
    assert.equal(held.acquired, true);
    await assert.rejects(
      buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed }),
      /being written by pid \d+/,
      'concurrent build gets a clear locked-by-PID error, no corruption',
    );
    releaseIndexLock(idx);
    // After release the same call succeeds and writes the index.
    const r = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.ok(r.chunks >= 1, 'build proceeds once the lock is free');
    assert.ok(fs.existsSync(path.join(idx, 'vectors.json')));
    assert.ok(fs.existsSync(path.join(idx, '.hashes.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: buildIndex leaves NO lock file behind on success (clean exit)', async () => {
  const dir = tempDir('lockclean');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Hockey\n\nthe hockey match sent the puck flying across the arena\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.ok(fs.existsSync(path.join(idx, 'vectors.json')));
    assert.ok(!fs.existsSync(path.join(idx, LOCK_FILENAME)),
      'a finished build must not leave the lock behind (else the next run is blocked)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: a lock swapped by another writer during reclaim is never unlinked (issue #188)', () => {
  const dir = tempDir('locktoctou');
  const lockPath = path.join(dir, LOCK_FILENAME);
  try {
    // the stale lock we classify as reclaimable
    const staleOwner = { pid: aDeadPid(), since: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(lockPath, JSON.stringify(staleOwner) + '\n');

    // the other writer wins the race INSIDE the classify→unlink window:
    // it unlinks the stale lock and creates a fresh, live one
    const freshOwner = { pid: process.pid, since: new Date().toISOString() };
    const freshPayload = JSON.stringify(freshOwner) + '\n';
    const r = acquireIndexLock(dir, {
      onClassified: () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, freshPayload);
      },
    });

    assert.equal(r.acquired, false, 'yield to the fresh lock');
    assert.match(r.reason, /changed while reclaiming/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), freshPayload, 'the live lock is intact — not unlinked');
    assert.equal(r.pid, freshOwner.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('lock: a stale lock with unchanged identity is still reclaimed after re-verify (issue #188)', () => {
  const dir = tempDir('locktoctou-ok');
  const lockPath = path.join(dir, LOCK_FILENAME);
  try {
    const staleOwner = { pid: aDeadPid(), since: '2026-01-01T00:00:00.000Z' };
    const stalePayload = JSON.stringify(staleOwner) + '\n';
    fs.writeFileSync(lockPath, stalePayload);

    const r = acquireIndexLock(dir, {
      onClassified: () => {
        /* no interleave — identity still matches at re-verify */
      },
    });
    assert.equal(r.acquired, true, 'genuinely stale lock is still reclaimed');
    assert.equal(pidAlive(process.pid), true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid, 'our lock now owns it');
    releaseIndexLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

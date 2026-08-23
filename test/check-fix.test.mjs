import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex } from '../dist/search.js';
import { planRepairs, applyRepairs } from '../dist/repair.js';
import { LOCK_FILENAME } from '../dist/core.js';

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

/** Healthy tiny index; returns {db, idx}. */
async function seed() {
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-fix-db-'));
  const idx = path.join(db, '.mdss');
  fs.writeFileSync(path.join(db, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
  await buildIndex({ db, indexDir: idx, cacheDir: path.join(db, 'cache'), modelName: 'e5-base', embedFn: fakeEmbed });
  return { db, idx };
}

test('check --fix: stale lock is planned, dry-run keeps it, apply removes it (issue #117)', async () => {
  const { db, idx } = await seed();
  try {
    const lock = path.join(idx, LOCK_FILENAME);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_000_000, since: new Date().toISOString() }));

    const plan = planRepairs(idx, {});
    assert.ok(plan.actions.some((a) => a.action === 'remove-stale-lock'), 'dead-pid lock planned');

    const before = fs.statSync(lock).mtimeMs;
    const dry = await applyRepairs(idx, plan, { dryRun: true });
    assert.equal(dry.performed.length, plan.actions.length, 'dry-run reports actions as performed-plan');
    assert.ok(fs.existsSync(lock), 'dry-run does NOT delete the lock');
    assert.equal(fs.statSync(lock).mtimeMs, before, 'dry-run leaves mtime untouched');

    await applyRepairs(idx, plan, { dryRun: false });
    assert.ok(!fs.existsSync(lock), 'apply removes the stale lock');
  } finally {
    safeRm(db);
  }
});

test('check --fix: live writer lock is skipped, not removed (issue #117)', async () => {
  const { db, idx } = await seed();
  try {
    const lock = path.join(idx, LOCK_FILENAME);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    const plan = planRepairs(idx, {});
    assert.ok(plan.skipped.some((s) => s.action === 'remove-stale-lock' && /live writer/.test(s.detail)));
    assert.ok(!plan.actions.some((a) => a.action === 'remove-stale-lock'));
    assert.ok(fs.existsSync(lock));
  } finally {
    safeRm(db);
  }
});

test('check --fix: SHA-mismatched vectors.bin removed on apply; loadIndex falls back to JSON (issue #117)', async () => {
  const { db, idx } = await seed();
  try {
    const binPath = path.join(idx, 'vectors.bin');
    const shaPath = `${binPath}.sha256`;
    if (!fs.existsSync(binPath)) return; // build variant without binary sidecar — nothing to corrupt
    // flip a byte inside the bin so its hash no longer matches the sidecar
    const buf = fs.readFileSync(binPath);
    buf[buf.length - 1] ^= 0xff;
    fs.writeFileSync(binPath, buf);

    const plan = planRepairs(idx, {});
    assert.ok(plan.actions.some((a) => a.action === 'remove-broken-vectors-bin'), 'sha mismatch detected');

    await applyRepairs(idx, plan, { dryRun: false });
    assert.ok(!fs.existsSync(binPath), 'broken bin deleted');
    assert.ok(fs.existsSync(path.join(idx, 'vectors.json')), 'canonical json survives');
    loadIndex(idx); // must not throw — falls back to vectors.json
  } finally {
    safeRm(db);
  }
});

test('check --fix: corrupt ivf.json removed; corrupt .hashes.json recomputed from source md5 (issue #117)', async () => {
  const { db, idx } = await seed();
  try {
    fs.writeFileSync(path.join(idx, 'ivf.json'), '{not json');
    fs.writeFileSync(path.join(idx, '.hashes.json'), '{also broken');

    const plan = planRepairs(idx, { db });
    assert.ok(plan.actions.some((a) => a.action === 'remove-corrupt-ivf'));
    assert.ok(plan.actions.some((a) => a.action === 'rewrite-hashes'));

    await applyRepairs(idx, plan, { dryRun: false, db });
    const hashes = JSON.parse(fs.readFileSync(path.join(idx, '.hashes.json'), 'utf8'));
    const expectedMd5 = crypto.createHash('md5').update(fs.readFileSync(path.join(db, 'a.md'))).digest('hex');
    assert.equal(hashes['a.md'], expectedMd5, 'hashes recomputed exactly as the indexer stores them');
    loadIndex(idx);
  } finally {
    safeRm(db);
  }
});

test('check --fix: corrupt vectors.json rebuilds with --db, skipped without it (issue #117)', async () => {
  const { db, idx } = await seed();
  try {
    fs.writeFileSync(path.join(idx, 'vectors.json'), '{"schemaVersion": 99, broken');

    let plan = planRepairs(idx, {});
    assert.ok(plan.skipped.some((s) => s.action === 'rebuild-index' && /--db/.test(s.detail)),
      'without db the rebuild is skipped with guidance');

    plan = planRepairs(idx, { db });
    assert.ok(plan.actions.some((a) => a.action === 'rebuild-index'));

    const res = await applyRepairs(idx, plan, {
      dryRun: false, db,
      cacheDir: path.join(db, 'cache'),
      modelName: 'e5-base',
      embedFn: fakeEmbed, // DI — no model download inside repair tests
    });
    assert.ok(res.performed.some((a) => a.action === 'rebuild-index'), 'rebuild performed');
    const loaded = loadIndex(idx);
    assert.ok(loaded.index.chunks.length >= 1, 'rebuilt index is searchable');
  } finally {
    safeRm(db);
  }
});

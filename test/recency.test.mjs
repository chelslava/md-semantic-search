import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex, resolvePassageAgeMs, recencyBoost } from '../dist/search.js';

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

const NOW = Date.parse('2026-08-23T12:00:00Z');
const DAY = 86_400_000;

test('recency: deterministic boost math — boundaries and clamps (issue #127)', () => {
  assert.equal(recencyBoost(null, 30, NOW), 1, 'unknown age → no boost change');
  assert.equal(recencyBoost(NOW, 30, NOW), 1, 'age 0 → factor 1');
  assert.equal(recencyBoost(NOW - 30 * DAY, 30, NOW), 0.5, 'one half-life → exactly 0.5');
  assert.equal(recencyBoost(NOW - 60 * DAY, 30, NOW), 0.25, 'two half-lives → 0.25');
  assert.equal(recencyBoost(NOW + 10 * DAY, 30, NOW), 1, 'future date clamps to factor 1');
  assert.equal(recencyBoost(NOW - 3 * DAY, 0, NOW), 1, 'disabled (0) → 1');
});

test('recency: age source priority — created beats updated beats mtime (issue #127)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-recency-'));
  try {
    const f = path.join(dir, 'a.md');
    fs.writeFileSync(f, 'x');
    const mtime = Date.now() - 100 * DAY;
    fs.utimesSync(f, new Date(mtime), new Date(mtime));

    // neither frontmatter date → mtime fallback
    assert.equal(resolvePassageAgeMs({}, f), mtime);

    // updated present → beats mtime
    const updated = '2026-08-01T00:00:00Z';
    assert.equal(resolvePassageAgeMs({ updated }, f), Date.parse(updated));

    // created wins over updated
    const created = '2026-07-01T00:00:00Z';
    assert.equal(
      resolvePassageAgeMs({ created, updated }, f),
      Date.parse(created),
      'created has priority over updated',
    );

    // invalid strings skipped → falls to mtime
    assert.equal(resolvePassageAgeMs({ created: 'garbage', updated: 'also-bad' }, f), mtime);

    // nothing at all → null
    assert.equal(resolvePassageAgeMs({}), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recency: end-to-end — fresh outranks stale with small half-life; explain exposes factors; off = unchanged (issue #127)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-recency-e2e-'));
  try {
    // stale.md matches the query words EXACTLY (strong lexical lane);
    // fresh.md shares only the generic word but carries a recent `updated`.
    fs.writeFileSync(
      path.join(dir, 'stale.md'),
      '---\nupdated: 2020-01-15\n---\n# Failover\n\nfailover runbook failover failover steps here\n',
    );
    fs.writeFileSync(path.join(dir, 'fresh.md'), '# Fresh notes\n\nfresh coffee beans general notes\n');
    // make fresh.md's mtime "yesterday" via frontmatter instead:
    fs.writeFileSync(
      path.join(dir, 'fresh.md'),
      '---\nupdated: 2026-08-22\n---\n# Fresh notes\n\nfresh coffee runbook general notes\n',
    );
    const idx = path.join(dir, '.mdss');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const loaded = loadIndex(idx);

    // baseline (off): stale first thanks to exact word overlap
    const base = await searchIndex({ loaded, cacheDir: path.join(dir, '.c'), query: 'failover runbook', k: 5, embedFn: fakeEmbed });
    assert.equal(base[0].file, 'stale.md', 'baseline keeps lexical winner on top');

    // with a tiny half-life the year-old note decays below the fresh one.
    // fresh.md carries ONE shared token ('runbook') so it enters the fusion
    // pool at rank 2 — recency then flips the order.
    const boosted = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'failover runbook', k: 5,
      embedFn: fakeEmbed, recency: 30, explain: true,
    });
    const files = boosted.map((h) => h.file);
    assert.ok(files.includes('stale.md') && files.includes('fresh.md'), 'both docs reach the pool');
    assert.equal(files[0], 'fresh.md', `fresh content overtakes decayed lexical winner, got ${files[0]}`);

    const staleHit = boosted.find((h) => h.file === 'stale.md');
    const freshHit = boosted.find((h) => h.file === 'fresh.md');
    const staleFactor = staleHit?.explain?.recencyFactor;
    const freshFactor = freshHit?.explain?.recencyFactor;
    assert.ok(typeof staleFactor === 'number' && typeof freshFactor === 'number', 'explain surfaces factors');
    assert.ok(freshFactor > staleFactor, `fresh factor higher (${freshFactor} > ${staleFactor})`);
    assert.ok(staleHit.explain.rrfScore !== undefined, 'raw rrfScore still reported');
    // final score equals rrfScore * factor
    assert.ok(
      Math.abs(staleHit.score - +(staleHit.explain.rrfScore * staleFactor).toFixed(4)) < 1e-3,
      'score = rrfScore × recencyFactor',
    );
    assert.ok(typeof staleHit.explain.recencyAgeDays === 'number' && staleHit.explain.recencyAgeDays > 300);

    // omitting the flag again reproduces the baseline order EXACTLY
    const off = await searchIndex({ loaded, cacheDir: path.join(dir, '.c'), query: 'failover runbook', k: 5, embedFn: fakeEmbed });
    assert.deepEqual(off.map((h) => h.score), base.map((h) => h.score), 'zero behavioral change when flag omitted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

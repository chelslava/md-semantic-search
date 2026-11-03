import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, percentile, summarizeLatencies, generateCorpus,
  compareWithBaseline, GATED_METRICS,
} from '../bench/e2e.mjs';

test('bench e2e #196: corpus generator is deterministic per seed (same bytes, different seeds differ)', () => {
  const a = generateCorpus({ fileCount: 6, sections: 3, seed: 196 });
  const b = generateCorpus({ fileCount: 6, sections: 3, seed: 196 });
  const c = generateCorpus({ fileCount: 6, sections: 3, seed: 197 });
  assert.equal(a.files.size, 6);
  assert.deepEqual([...a.files.entries()], [...b.files.entries()], 'same seed → same corpus');
  assert.notDeepEqual([...a.files.values()], [...c.files.values()], 'different seed → different corpus');
  // structural sanity: headings present, code fences balanced, RU/EN mix
  const sample = [...a.files.values()][0];
  assert.ok(sample.startsWith('# '));
  assert.ok(sample.includes('## '));
  assert.equal((sample.match(/```/g) || []).length % 2, 0);
  assert.ok(a.vocabulary.length > 0);
  assert.ok(a.vocabulary.every((v) => v.words.length >= 5));
});

test('bench e2e #196: percentile interpolation and latency summary', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 99), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5, 'even count interpolates');
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);

  const s = summarizeLatencies([10, 20, 30, 40]);
  assert.equal(s.n, 4);
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);
  assert.equal(s.mean, 25);
  assert.equal(s.p50, 25);
  assert.deepEqual(summarizeLatencies([]), { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, n: 0 });
});

test('bench e2e #196: gate — +20% tolerance catches regressions, ignores improvements and unknown metrics', () => {
  const baseline = {
    metrics: {
      loadIndexColdMs: 50,
      loadIndexWarmMs: 30,
      hybridP95Ms: 10,
      missP99Ms: 8,
      rssAfterLoadMb: 170,
      metricNotGated: 123, // not in GATED_METRICS → ignored even here
    },
  };
  // identical run passes
  const same = compareWithBaseline({ metrics: { ...baseline.metrics } }, baseline, 20);
  assert.equal(same.ok, true);

  // +15% on every gated metric → still within +20%
  const mild = compareWithBaseline(
    { metrics: Object.fromEntries(Object.entries(baseline.metrics).map(([k, v]) => [k, v * 1.15])) },
    baseline, 20,
  );
  assert.equal(mild.ok, true);

  // +25% on ONE metric → exactly that regression named
  const bad = { ...baseline.metrics, hybridP95Ms: 12.6 };
  const gate = compareWithBaseline({ metrics: bad }, baseline, 20);
  assert.equal(gate.ok, false);
  assert.equal(gate.regressions.length, 1);
  assert.equal(gate.regressions[0].metric, 'hybridP95Ms');
  assert.equal(gate.regressions[0].ratio, 1.26);

  // improvements never fail
  const better = compareWithBaseline(
    { metrics: Object.fromEntries(Object.entries(baseline.metrics).map(([k, v]) => [k, v * 0.5])) },
    baseline, 20,
  );
  assert.equal(better.ok, true);

  // a gated metric absent from the baseline is skipped (cannot regress vs nothing)
  const grownBaseline = compareWithBaseline({ metrics: { newMetricP50Ms: 9999 } }, { metrics: {} }, 20);
  assert.equal(grownBaseline.ok, true);

  // no baseline at all → pass
  assert.equal(compareWithBaseline({ metrics: { loadIndexColdMs: 1e9 } }, null, 20).ok, true);

  // GATED_METRICS covers the four profiles' tails
  for (const p of ['hybrid', 'semantic', 'ann', 'miss']) {
    assert.ok(GATED_METRICS.includes(`${p}P95Ms`), `${p} tail gated`);
  }
  assert.ok(GATED_METRICS.includes('loadIndexWarmMs'));
  assert.ok(GATED_METRICS.includes('rssAfterQueriesMb'));
  assert.ok(!GATED_METRICS.includes('buildIndexMs'), 'indexing time is informational, not gated');
});

test('bench e2e #196: mulberry32 is stable across calls and instances', () => {
  const a = mulberry32(196);
  const b = mulberry32(196);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

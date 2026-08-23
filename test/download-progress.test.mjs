import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadProgressAggregator } from '../dist/download-progress.js';
import { setDownloadProgressListener, emitDownloadEvent } from '../dist/core.js';

const T0 = 1_700_000_000_000;

test('download-progress: aggregates percent/bytes across model files (issue #108)', () => {
  const agg = new DownloadProgressAggregator();
  // before anything: silent, incomplete, zeroed
  let s = agg.snapshot();
  assert.equal(s.reportable, false, 'warm-cache gate starts closed');
  assert.equal(s.complete, false);
  assert.equal(s.percent, null);

  // file A streams 50 of 200 MB; file B only announces its total
  agg.update({ status: 'initiate', file: 'onnx/model.onnx' }, T0);
  agg.update({ status: 'download', file: 'onnx/model.onnx', loaded: 0, total: 200e6 }, T0 + 10);
  agg.update({ status: 'progress', file: 'onnx/model.onnx', loaded: 50e6, total: 200e6 }, T0 + 20);
  agg.update({ status: 'initiate', file: 'tokenizer.json' }, T0 + 21);
  agg.update({ status: 'progress', file: 'tokenizer.json', loaded: 2e6, total: 0 }, T0 + 22);

  s = agg.snapshot();
  assert.equal(s.reportable, true, 'partial transfer opens the gate');
  assert.equal(s.complete, false);
  assert.equal(s.totalBytes, 200e6, 'unknown-total files excluded from the denominator');
  assert.equal(s.loadedBytes, 52e6);
  assert.ok(Math.abs(s.percent - 26) < 0.01, `percent across known totals, got ${s.percent}`);
  assert.equal(s.doneFiles, 0);
});

test('download-progress: speed EMA and ETA appear after byte growth (issue #108)', () => {
  const agg = new DownloadProgressAggregator();
  agg.update({ status: 'download', file: 'm.onnx', loaded: 0, total: 100e6 }, T0);
  agg.update({ status: 'progress', file: 'm.onnx', loaded: 10e6, total: 100e6 }, T0 + 1000); // 10 MB/s
  const s1 = agg.snapshot();
  assert.ok(s1.mbps !== null && s1.mbps > 0, `mbps computed, got ${s1.mbps}`);
  // 10e6 bytes in 1s ≈ 9.5 MB/s; 90 MB remaining → ETA ≈ 9 s
  assert.ok(s1.etaSec !== null && s1.etaSec > 8 && s1.etaSec < 11, `ETA ≈ remaining/speed, got ${s1.etaSec}`);

  // a faster second sample pulls the EMA up and the ETA down
  agg.update({ status: 'progress', file: 'm.onnx', loaded: 40e6, total: 100e6 }, T0 + 3000);
  const s2 = agg.snapshot();
  assert.ok(s2.mbps > s1.mbps, `EMA reacts upward, got ${s2.mbps} vs ${s1.mbps}`);
  assert.ok(s2.etaSec < s1.etaSec);
});

test('download-progress: warm cache (instant complete events) stays fully silent (issue #108)', () => {
  const agg = new DownloadProgressAggregator();
  const renders = [];
  for (let i = 0; i < 5; i++) {
    agg.update({ status: 'progress', file: `f${i}`, loaded: 100, total: 100 }, T0 + i);
    if (agg.shouldRender(T0 + i)) renders.push(i);
  }
  assert.equal(agg.snapshot().reportable, false, 'no partial transfer observed');
  assert.deepEqual(renders, [], 'shouldRender never fires without a real transfer');
});

test('download-progress: complete transition renders exactly once (issue #108)', () => {
  const agg = new DownloadProgressAggregator();
  agg.update({ status: 'download', file: 'm.onnx', loaded: 0, total: 10e6 }, T0);
  agg.update({ status: 'progress', file: 'm.onnx', loaded: 5e6, total: 10e6 }, T0 + 500);
  assert.equal(agg.shouldRender(T0 + 600), true, 'interval elapsed → render');

  // within the throttle window: silent…
  assert.equal(agg.shouldRender(T0 + 700), false);

  // …but the completion transition always passes, exactly once
  agg.update({ status: 'done', file: 'm.onnx', loaded: 10e6, total: 10e6 }, T0 + 800);
  const s = agg.snapshot();
  assert.equal(s.complete, true);
  assert.equal(s.activeFiles, 0);
  assert.equal(agg.shouldRender(T0 + 800), true, 'complete renders despite throttle');
  assert.equal(agg.shouldRender(T0 + 900), false, 'and not twice');
});

test('download-progress: listener loop — core emits reach a registered listener (issue #108)', () => {
  const seen = [];
  setDownloadProgressListener((e) => seen.push(e));
  try {
    emitDownloadEvent({ status: 'progress', file: 'a.bin', loaded: 1, total: 2 });
    emitDownloadEvent({ status: 'done', file: 'a.bin', loaded: 2, total: 2 });
    assert.equal(seen.length, 2);

    // a throwing listener must not propagate into the loader path
    setDownloadProgressListener(() => { throw new Error('boom'); });
    assert.doesNotThrow(() => emitDownloadEvent({ status: 'progress', file: 'b.bin' }));
  } finally {
    setDownloadProgressListener(null);
  }
  emitDownloadEvent({ status: 'progress', file: 'c.bin' });
  assert.equal(seen.length, 2, 'detached listener receives nothing more');
});

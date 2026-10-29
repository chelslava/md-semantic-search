// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resolveSessionOptions, getExtractorCacheKey } from '../dist/core.js';

test('resolveSessionOptions reads environment variables and adapter properties', () => {
  const origIntra = process.env.MDSS_INTRA_OP_THREADS;
  const origNum = process.env.MDSS_NUM_THREADS;
  const origInter = process.env.MDSS_INTER_OP_THREADS;

  try {
    delete process.env.MDSS_INTRA_OP_THREADS;
    delete process.env.MDSS_NUM_THREADS;
    delete process.env.MDSS_INTER_OP_THREADS;

    // No env and no adapter sessionOptions -> the issue #194 default:
    // intraOpNumThreads = physical-ish cores (max(1, min(4, logical/2)))
    const expectedDefault = Math.max(1, Math.min(4, os.cpus().length >> 1));
    assert.deepEqual(resolveSessionOptions(), { intraOpNumThreads: expectedDefault });

    // Adapter sessionOptions -> returned
    const opts1 = resolveSessionOptions({
      id: 'test', nativeDim: 4, dim: 4, queryPrefix: '', passagePrefix: '', pooling: 'mean',
      sessionOptions: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    });
    assert.deepEqual(opts1, { intraOpNumThreads: 4, interOpNumThreads: 1 });

    // Env vars take precedence
    process.env.MDSS_NUM_THREADS = '8';
    process.env.MDSS_INTER_OP_THREADS = '2';
    const opts2 = resolveSessionOptions();
    assert.deepEqual(opts2, { intraOpNumThreads: 8, interOpNumThreads: 2 });
  } finally {
    if (origIntra !== undefined) process.env.MDSS_INTRA_OP_THREADS = origIntra; else delete process.env.MDSS_INTRA_OP_THREADS;
    if (origNum !== undefined) process.env.MDSS_NUM_THREADS = origNum; else delete process.env.MDSS_NUM_THREADS;
    if (origInter !== undefined) process.env.MDSS_INTER_OP_THREADS = origInter; else delete process.env.MDSS_INTER_OP_THREADS;
  }
});

test('getExtractorCacheKey includes session options in cache identity', () => {
  const model1 = { id: 'test-model', nativeDim: 4, dim: 4, queryPrefix: '', passagePrefix: '', pooling: /** @type {const} */ ('mean') };
  // a DIFFERENT thread count from the issue #194 default — same options must
  // share an extractor, different ones must not
  const model2 = { ...model1, sessionOptions: { intraOpNumThreads: 1 } };

  const key1 = getExtractorCacheKey(model1, '.cache', true);
  const key2 = getExtractorCacheKey(model2, '.cache', true);

  assert.notEqual(key1, key2);
  assert.match(key2, /intraOpNumThreads/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkError, retryWithBackoff } from '../src/core.mjs';

test('retry: isNetworkError identifies network-class errors correctly', () => {
  assert.equal(isNetworkError({ code: 'ENOTFOUND' }), true);
  assert.equal(isNetworkError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isNetworkError({ name: 'FetchError' }), true);
  assert.equal(isNetworkError({ status: 503 }), true);
  assert.equal(isNetworkError(new Error('fetch failed')), true);

  assert.equal(isNetworkError(new SyntaxError('Unexpected token')), false);
  assert.equal(isNetworkError(new TypeError('Cannot read property')), false);
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError(undefined), false);
});

test('retry: retryWithBackoff retries transient network errors and succeeds when attempt succeeds', async () => {
  let attempts = 0;
  const logs = [];
  const fn = async () => {
    attempts++;
    if (attempts < 3) {
      const err = new Error('fetch failed');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    return 'success';
  };

  const result = await retryWithBackoff(fn, {
    maxRetries: 3,
    delays: [1, 1, 1], // fast delays for tests
    log: (msg) => logs.push(msg),
  });

  assert.equal(result, 'success');
  assert.equal(attempts, 3);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /retrying model download \(attempt 1\/3\)/);
  assert.match(logs[1], /retrying model download \(attempt 2\/3\)/);
});

test('retry: retryWithBackoff throws after max retries are exhausted for network errors', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    const err = new Error('getaddrinfo ENOTFOUND huggingface.co');
    err.code = 'ENOTFOUND';
    throw err;
  };

  await assert.rejects(
    () => retryWithBackoff(fn, { maxRetries: 3, delays: [1, 1, 1] }),
    /model download failed after 3 attempts — check network or use --offline/
  );
  assert.equal(attempts, 4); // 1 initial + 3 retries
});

test('retry: retryWithBackoff does not retry non-network errors', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new TypeError('Invalid ONNX tensor format');
  };

  await assert.rejects(
    () => retryWithBackoff(fn, { maxRetries: 3, delays: [1, 1, 1] }),
    (err) => err instanceof TypeError && err.message === 'Invalid ONNX tensor format'
  );
  assert.equal(attempts, 1);
});

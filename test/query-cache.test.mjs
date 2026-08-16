// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryEmbeddingCache, searchIndex } from '../src/search.mjs';

function makeTestIndex() {
  return /** @type {import('../src/search.mjs').IndexFile} */ ({
    format: 'binary-v1',
    schemaVersion: 3,
    model: 'custom-4d',
    dim: 4,
    chunkCount: 2,
    lexical: {
      format: 'bm25-v2',
      documentLengths: [0, 0],
      postings: {},
    },
    chunks: [
      { file: 'a.md', title: 'A', heading: 'A', headingPath: ['A'], text: 'backup schedule', chunkHash: 'hash1', vec: [0.1, 0.2, 0.3, 0.4] },
      { file: 'b.md', title: 'B', heading: 'B', headingPath: ['B'], text: 'failover runbook', chunkHash: 'hash2', vec: [0.4, 0.3, 0.2, 0.1] },
    ],
  });
}

test('QueryEmbeddingCache LRU eviction and getter/setter', () => {
  const cache = new QueryEmbeddingCache(2);
  const vec1 = new Float32Array([1, 0, 0]);
  const vec2 = new Float32Array([0, 1, 0]);
  const vec3 = new Float32Array([0, 0, 1]);

  cache.set('k1', vec1);
  cache.set('k2', vec2);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get('k1'), vec1);

  // Inserting third entry evicts oldest (k2 since k1 was accessed)
  cache.set('k3', vec3);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get('k1'), vec1);
  assert.deepEqual(cache.get('k3'), vec3);
  assert.equal(cache.get('k2'), undefined);

  cache.clear();
  assert.equal(cache.size, 0);
});

test('QueryEmbeddingCache coalesces in-flight concurrent requests', async () => {
  const cache = new QueryEmbeddingCache(10);
  let invocations = 0;

  const fn = async () => {
    invocations++;
    await new Promise(r => setTimeout(r, 10));
    return new Float32Array([0.5, 0.5]);
  };

  const [res1, res2] = await Promise.all([
    cache.getOrCompute('key1', fn),
    cache.getOrCompute('key1', fn),
  ]);

  assert.equal(invocations, 1);
  assert.deepEqual(res1, res2);
  assert.equal(cache.size, 1);
});

test('searchIndex reuses cached query vector across repeated queries', async () => {
  const index = makeTestIndex();
  let embedCalls = 0;

  const fakeEmbedFn = async (texts) => {
    embedCalls++;
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  };

  const loaded = {
    index,
    model: { id: 'custom-4d', dim: 4, queryPrefix: '', pooling: 'mean', normalize: true },
  };

  const hits1 = await searchIndex({
    loaded,
    cacheDir: '.cache',
    query: 'backup schedule',
    embedFn: fakeEmbedFn,
  });

  assert.equal(embedCalls, 1);
  assert.equal(hits1.length, 2);

  // Second search with identical query reuses cached query vector
  const hits2 = await searchIndex({
    loaded,
    cacheDir: '.cache',
    query: 'backup schedule',
    embedFn: fakeEmbedFn,
  });

  assert.equal(embedCalls, 1); // no extra embed call!
  assert.deepEqual(hits1[0].file, hits2[0].file);

  // Bypassing cache forces fresh embed call
  await searchIndex({
    loaded,
    cacheDir: '.cache',
    query: 'backup schedule',
    useQueryCache: false,
    embedFn: fakeEmbedFn,
  });

  assert.equal(embedCalls, 2);
});

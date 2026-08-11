import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import * as core from '../src/core.mjs';
import { chunkHash } from '../src/indexer.mjs';

const QWEN_ALIAS = 'qwen3-embedding-0.6b';
const QWEN_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const QWEN_REVISION = 'c25a394dd583836952667c12f008335071b3f43d';
const QWEN_QUERY_PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

function requiredProfile(model) {
  return {
    id: model.id,
    revision: model.revision,
    dim: model.dim,
    queryPrefix: model.queryPrefix,
    passagePrefix: model.passagePrefix,
    pooling: model.pooling,
  };
}

const EXPECTED_QWEN_PROFILE = {
  id: QWEN_ID,
  revision: QWEN_REVISION,
  dim: 1024,
  queryPrefix: QWEN_QUERY_PREFIX,
  passagePrefix: '',
  pooling: 'last_token',
};

test('resolveModel returns the pinned Qwen3 profile when given its alias', () => {
  // Given
  const alias = QWEN_ALIAS;

  // When
  const model = core.resolveModel(alias);

  // Then
  assert.deepEqual(requiredProfile(model), EXPECTED_QWEN_PROFILE);
});

test('resolveModel returns the pinned Qwen3 profile when given its registered raw id', () => {
  // Given
  const aliasModel = core.resolveModel(QWEN_ALIAS);

  // When
  const rawModel = core.resolveModel(QWEN_ID);

  // Then
  assert.deepEqual(requiredProfile(rawModel), EXPECTED_QWEN_PROFILE);
  assert.deepEqual(rawModel, aliasModel);
});

test('resolveModel overrides only the Qwen3 revision when the raw id pins main', () => {
  // Given
  const pinnedModel = core.resolveModel(QWEN_ALIAS);

  // When
  const mainModel = core.resolveModel(`${QWEN_ID}@main`);

  // Then
  assert.deepEqual(requiredProfile(mainModel), {
    ...EXPECTED_QWEN_PROFILE,
    revision: 'main',
  });
  assert.deepEqual(mainModel, { ...pinnedModel, revision: 'main' });
});

test('prepareEmbeddingRequest applies model prefixes and pooling by request kind', () => {
  // Given
  const qwen = core.resolveModel(QWEN_ALIAS);
  const e5 = core.resolveModel('e5-base');

  // When
  assert.equal(typeof core.prepareEmbeddingRequest, 'function');
  const query = core.prepareEmbeddingRequest(qwen, ['rotation'], 'query');
  const passage = core.prepareEmbeddingRequest(qwen, ['rotation'], 'passage');
  const e5Query = core.prepareEmbeddingRequest(e5, ['rotation'], 'query');

  // Then
  assert.deepEqual(query, {
    input: [`${QWEN_QUERY_PREFIX}rotation`],
    options: { pooling: 'last_token', normalize: true },
  });
  assert.deepEqual(passage, {
    input: ['rotation'],
    options: { pooling: 'last_token', normalize: true },
  });
  assert.deepEqual(e5Query, {
    input: ['query: rotation'],
    options: { pooling: 'mean', normalize: true },
  });
});

test('getPipelineModelSource uses the cached revision directory for offline pinned models', () => {
  // Given
  const cacheDir = path.join('cache', 'models');
  const model = core.resolveModel(QWEN_ALIAS);

  // When
  const source = core.getPipelineModelSource(model, cacheDir, true);

  // Then
  assert.equal(source, path.join(cacheDir, QWEN_ID, QWEN_REVISION));
});

test('getPipelineModelSource keeps the remote id for online pinned models', () => {
  // Given
  const model = core.resolveModel(QWEN_ALIAS);

  // When
  const source = core.getPipelineModelSource(model, path.join('cache', 'models'), false);

  // Then
  assert.equal(source, QWEN_ID);
});

test('getPipelineModelSource keeps the remote id for offline main models', () => {
  // Given
  const model = core.resolveModel(`${QWEN_ID}@main`);

  // When
  const source = core.getPipelineModelSource(model, path.join('cache', 'models'), true);

  // Then
  assert.equal(source, QWEN_ID);
});

test('getPipelineModelSource preserves the default e5-base source offline', () => {
  // Given
  const model = core.resolveModel('e5-base');

  // When
  const source = core.getPipelineModelSource(model, path.join('cache', 'models'), true);

  // Then
  assert.equal(source, model.id);
});

test('getExtractorCacheKey separates pinned offline cache sources', () => {
  // Given
  const model = core.resolveModel(QWEN_ALIAS);
  const cacheA = path.join('cache', 'a');
  const cacheB = path.join('cache', 'b');

  // When
  const keyA = core.getExtractorCacheKey(model, cacheA, true);
  const keyB = core.getExtractorCacheKey(model, cacheB, true);
  const repeatedA = core.getExtractorCacheKey(model, cacheA, true);

  // Then
  assert.notEqual(keyA, keyB);
  assert.equal(keyA, repeatedA);
});

test('getExtractorCacheKey keeps online Qwen cache-dir independent', () => {
  // Given
  const model = core.resolveModel(QWEN_ALIAS);

  // When
  const keyA = core.getExtractorCacheKey(model, path.join('cache', 'a'), false);
  const keyB = core.getExtractorCacheKey(model, path.join('cache', 'b'), false);

  // Then
  assert.equal(keyA, keyB);
});

test('chunkHash preserves mean hashes and separates last-token pooling', () => {
  // Given
  const chunk = {
    title: 'Credential Rotation',
    heading: 'Runbook',
    headingPath: ['Credential Rotation', 'Runbook'],
    text: 'Rotate the exposed token.',
  };
  const model = {
    id: QWEN_ID,
    revision: QWEN_REVISION,
    passagePrefix: '',
  };

  // When
  const omittedPooling = chunkHash(model, chunk);
  const meanPooling = chunkHash({ ...model, pooling: 'mean' }, chunk);
  const lastTokenPooling = chunkHash({ ...model, pooling: 'last_token' }, chunk);

  // Then
  assert.equal(meanPooling, omittedPooling);
  assert.notEqual(lastTokenPooling, omittedPooling);
});

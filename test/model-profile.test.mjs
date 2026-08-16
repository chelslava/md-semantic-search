import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import * as core from '../dist/core.js';
import { chunkHash } from '../dist/indexer.js';
import { normalizeAdapter, embeddingAdapterFingerprint, DEFAULT_MODEL } from '../dist/models.js';

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

// --- issue #60: explicit model adapter contract ---------------------------
// Registered adapters carry the full vector-producing semantics and route by
// structural fields, NOT by natural-language instruction prose.

test('adapters expose explicit vector-producing semantics (structural fields)', () => {
  const names = ['e5-small', 'e5-base', 'e5-large', 'bge-m3', 'qwen3-embedding-0.6b', DEFAULT_MODEL];
  for (const name of names) {
    const m = core.resolveModel(name);
    assert.equal(typeof m.id, 'string', `${name} id`);
    assert.equal(typeof m.queryPrefix, 'string', `${name} queryPrefix`);
    assert.equal(typeof m.passagePrefix, 'string', `${name} passagePrefix`);
    assert.ok(['mean', 'last_token', 'none'].includes(m.pooling), `${name} pooling`);
    assert.equal(typeof m.dim, 'number', `${name} dim`);
    assert.equal(typeof m.normalize, 'boolean', `${name} normalize`);
    assert.equal(m.unknownAdapter, undefined, `${name} is a usable adapter`);
  }
});

test('adapters route query/document formatting by structural fields, not prose', () => {
  // Two structurally identical adapters (same prefixes/pooling) must behave
  // identically even if their ids differ — routing is field-driven.
  const a = normalizeAdapter({
    id: 'Xenova/model-A', nativeDim: 384, dim: 384,
    queryPrefix: 'q: ', passagePrefix: 'p: ', pooling: 'mean', dtype: 'q8',
  });
  const b = normalizeAdapter({
    id: 'Xenova/model-B', nativeDim: 384, dim: 384,
    queryPrefix: 'q: ', passagePrefix: 'p: ', pooling: 'mean', dtype: 'q8',
  });
  assert.notEqual(a.id, b.id);
  // Same fingerprint ⇒ same produced vectors for identical adapters.
  assert.equal(embeddingAdapterFingerprint(a), embeddingAdapterFingerprint(b),
    'identical structural semantics hash identically regardless of id/revision');

  const req = core.prepareEmbeddingRequest(a, ['token'], 'query');
  assert.deepEqual(req.options, { pooling: 'mean', normalize: true });
  assert.deepEqual(req.input, ['q: token']);
});

test('prepared query/document inputs differ per adapter without duplicating retrieval logic', () => {
  const e5 = core.resolveModel('e5-base');
  const qwen = core.resolveModel('qwen3-embedding-0.6b');

  const e5Query = core.prepareEmbeddingRequest(e5, ['rotate'], 'query').input;
  const e5Passage = core.prepareEmbeddingRequest(e5, ['rotate'], 'passage').input;
  const qwenQuery = core.prepareEmbeddingRequest(qwen, ['rotate'], 'query').input;
  const qwenPassage = core.prepareEmbeddingRequest(qwen, ['rotate'], 'passage').input;

  assert.deepEqual(e5Query, ['query: rotate']);
  assert.deepEqual(e5Passage, ['passage: rotate']);
  assert.ok(qwenQuery[0].startsWith('Instruct:'), 'Qwen queries carry the retrieval instruction');
  assert.ok(qwenQuery[0].endsWith('rotate'), 'instruction is a query prefix');
  assert.deepEqual(qwenPassage, ['rotate'], 'Qwen passages stay unprefixed');
});

test('unknown raw ids fail safely instead of inheriting E5 heuristics', () => {
  // Raw id without `bge` in the name must NOT silently get E5 prefixes.
  const m = core.resolveModel('Xenova/reviewer-custom-model');
  assert.equal(m.unknownAdapter, true, 'neutral adapter is flagged unknown');
  assert.equal(m.id, 'Xenova/reviewer-custom-model');
  assert.throws(
    () => core.prepareEmbeddingRequest(m, ['x'], 'query'),
    /not a registered adapter/,
    'embed attempt fails with an actionable message (issue #60)',
  );
});

test('registered repo ids resolve to their owning adapter (no name heuristic)', () => {
  const byAlias = core.resolveModel('bge-m3');
  const byRawId = core.resolveModel('Xenova/bge-m3');
  assert.equal(byRawId.id, byAlias.id);
  assert.equal(byRawId.queryPrefix, '', 'BGE stays unprefixed via the adapter, not a name match');
  assert.equal(byRawId.pooling, 'mean');

  const qwenByRawId = core.resolveModel('onnx-community/Qwen3-Embedding-0.6B-ONNX');
  assert.equal(qwenByRawId.unknownAdapter, undefined, 'registered id is usable');
  assert.equal(qwenByRawId.pooling, 'last_token');
});

test('normalizeAdapter validates and pads an explicit descriptor', () => {
  const m = normalizeAdapter({
    id: 'custom/m', dim: 384, queryPrefix: 'query: ', passagePrefix: 'passage: ',
  });
  assert.equal(m.pooling, 'mean', 'default pooling');
  assert.equal(m.normalize, true, 'default normalize');
  assert.equal(m.dtype, 'q8', 'default dtype');
  assert.equal(m.dim, 384);

  assert.throws(() => normalizeAdapter({ id: 'x/m', pooling: 'bogus' }), /unsupported pooling/);
  assert.throws(() => normalizeAdapter(null), /adapter must be an object/);
});

test('fingerprint stays stable for e5-base and bge-m3', () => {
  // Regression (issue #60): normalizing default fields in the refactored
  // adapters must NOT change the adapter-v1 fingerprint, so schema-v3 indexes
  // and checkpoints built before #60 keep their vectors reusable.
  const e5Fp = embeddingAdapterFingerprint(core.resolveModel('e5-base'));
  const bgeFp = embeddingAdapterFingerprint(core.resolveModel('bge-m3'));
  const e5LegacyFp = embeddingAdapterFingerprint({
    dim: 768, queryPrefix: 'query: ', passagePrefix: 'passage: ', pooling: 'mean', normalize: true,
  });
  const bgeLegacyFp = embeddingAdapterFingerprint({
    dim: 1024, queryPrefix: '', passagePrefix: '', pooling: 'mean', normalize: true,
  });
  assert.equal(e5Fp, e5LegacyFp, 'e5-base fingerprint unchanged');
  assert.equal(bgeFp, bgeLegacyFp, 'bge-m3 fingerprint unchanged');
  assert.match(e5Fp, /^adapter-v1:[a-f0-9]{64}$/);
});

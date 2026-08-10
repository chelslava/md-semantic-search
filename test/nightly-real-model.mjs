// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cosine, decodeVec, embed, resolveModel } from '../src/core.mjs';
import { buildIndex } from '../src/indexer.mjs';
import { getReranker, rerankScores } from '../src/rerank.mjs';
import { search } from '../src/search.mjs';
import { createServe } from '../src/serve.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const MODEL_NAME = 'e5-small';
const DIMENSION = 384;
const nightlyEnabled = process.env.MDSS_RUN_NIGHTLY_REAL_MODEL === '1';
const cacheDir = path.resolve(
  process.env.MDSS_NIGHTLY_CACHE_DIR || path.join(os.homedir(), '.cache', 'mdss-nightly'),
);

test('nightly: real transformers index, search, serve, rerank, and offline failure', {
  skip: nightlyEnabled ? false : 'set MDSS_RUN_NIGHTLY_REAL_MODEL=1 to run real model inference',
  timeout: 30 * 60_000,
}, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-nightly-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, 'index');
  const emptyCacheDir = path.join(root, 'empty-cache');
  fs.mkdirSync(db, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(emptyCacheDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(db, 'credentials.md'), [
      '# Credential Rotation',
      '',
      '## Exposed API token',
      '',
      'Immediately revoke the exposed API token, generate a replacement token,',
      'update the secret store, and verify the old credential no longer works.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(db, 'baking.md'), [
      '# Banana Bread',
      '',
      '## Baking',
      '',
      'Mash ripe bananas, fold in flour, and bake until the center is set.',
      '',
    ].join('\n'));

    const buildStarted = Date.now();
    const result = await buildIndex({ db, indexDir, cacheDir, modelName: MODEL_NAME });
    context.diagnostic(`e5-small index completed in ${Date.now() - buildStarted} ms using ${cacheDir}`);
    assert.equal(result.dim, DIMENSION);
    assert.equal(result.embedded, 2);

    const storedIndex = JSON.parse(fs.readFileSync(path.join(indexDir, 'vectors.json'), 'utf8'));
    assert.equal(storedIndex.format, 'binary-v1');
    assert.equal(storedIndex.dim, DIMENSION);
    assert.equal(storedIndex.chunkCount, 2);

    for (const chunk of storedIndex.chunks) {
      assert.equal(typeof chunk.vec, 'string');
      const vector = decodeVec(chunk.vec, DIMENSION);
      assert.equal(vector.length, DIMENSION);
      assert.ok(vector.every(Number.isFinite));
    }

    const storedChunkIndex = storedIndex.chunks.findIndex((chunk) => chunk.file === 'credentials.md');
    assert.notEqual(storedChunkIndex, -1);
    const storedChunk = storedIndex.chunks[storedChunkIndex];
    assert.ok(storedChunk);
    const exactPassages = storedIndex.chunks.map(
      (chunk) => `${chunk.title}\n${chunk.heading}\n${chunk.text}`,
    );
    const freshVectors = await embed(
      exactPassages, 'passage', resolveModel(MODEL_NAME), cacheDir,
    );
    const freshVector = freshVectors[storedChunkIndex];
    const storedVector = decodeVec(storedChunk.vec, DIMENSION);
    const storageDelta = Math.abs(1 - cosine(freshVector, storedVector));
    assert.ok(storageDelta < 1e-4, `storage cosine delta ${storageDelta} must be below 1e-4`);

    const results = await search({
      indexDir,
      cacheDir,
      query: 'How should an exposed API token be replaced?',
      k: 2,
      semanticOnly: true,
      offline: true,
    });
    assert.equal(results[0]?.file, 'credentials.md');

    const rerankQuery = 'How do I replace an exposed API token?';
    const rerankPassages = [
      'Revoke the exposed token and issue a replacement credential in the secret store.',
      'Mash bananas and bake the loaf until its center is set.',
    ];
    const rerankStarted = Date.now();
    const { tokenizer, model } = await getReranker(cacheDir);
    const pairedInputs = tokenizer(new Array(rerankPassages.length).fill(rerankQuery), {
      text_pair: rerankPassages,
      padding: true,
      truncation: true,
    });
    const pairedOutputs = await model(pairedInputs);
    const logits = pairedOutputs.logits.tolist();
    assert.equal(logits.length, rerankPassages.length);
    for (const row of logits) {
      assert.ok(Array.isArray(row));
      assert.equal(row.length, 1);
      assert.ok(Number.isFinite(row[0]));
    }
    const rerank = await rerankScores(
      rerankQuery, rerankPassages, cacheDir,
    );
    context.diagnostic(`bge reranker completed in ${Date.now() - rerankStarted} ms`);
    assert.equal(rerank.length, 2);
    assert.ok(rerank.every(Number.isFinite));
    assert.ok(rerank[0] > rerank[1]);

    const service = await createServe({ indexDir, cacheDir });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      service.server.once('error', onError);
      service.server.listen(0, '127.0.0.1', () => {
        service.server.off('error', onError);
        resolve(undefined);
      });
    });
    try {
      const address = service.server.address();
      assert.ok(address && typeof address === 'object');
      assert.equal(address.address, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${address.port}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: rerankQuery, k: 2, rerank: true }),
        signal: AbortSignal.timeout(2 * 60_000),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(Array.isArray(payload.results));
      assert.ok(payload.results.length > 0);
      assert.ok(payload.results.every((hit) => Number.isFinite(hit.rerankScore)));
    } finally {
      await service.close();
    }

    const offline = spawnSync(process.execPath, [
      CLI,
      'search',
      '--db', db,
      '--index-dir', indexDir,
      '--cache-dir', emptyCacheDir,
      '--model', MODEL_NAME,
      '--offline',
      '--json',
      'replace exposed API token',
    ], {
      encoding: 'utf8',
      timeout: 2 * 60_000,
      windowsHide: true,
    });
    assert.equal(offline.error, undefined, `offline CLI failed to exit: ${offline.error?.message}`);
    assert.equal(typeof offline.status, 'number');
    assert.notEqual(offline.status, 0);
    assert.match(offline.stderr, /^error:/m);
    assert.match(
      offline.stderr,
      /local_files_only=true|allowRemoteModels=false|not found locally/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

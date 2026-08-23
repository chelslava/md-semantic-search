import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExternalEmbedder } from '../dist/providers.js';
import { embeddingAdapterFingerprint } from '../dist/models.js';

/** fetch stub scripted per-URL. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init?.headers || {}, body });
    const [status, payload] = handler(url, body, init?.headers || {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  fn.calls = calls;
  return fn;
}

test('providers: ollama — /api/embed shape, batch order, dim probe (issue #124)', async () => {
  const f = stubFetch((url, body) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/embed');
    assert.equal(body.model, 'nomic-embed-text');
    return [200, { embeddings: body.input.map((t) => [t.length, 1, 2]) }];
  });
  const emb = resolveExternalEmbedder({ embedder: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:11434', fetchImpl: f });
  const desc = await emb.descriptor(); // probe
  assert.equal(desc.dim, 3);
  assert.equal(desc.id, 'ollama/nomic-embed-text');

  const out = await emb.embedFn(['alpha', 'beta'], 'passage', desc, '', false);
  assert.deepEqual(out, [[5, 1, 2], [4, 1, 2]]);
});

test('providers: openai — bearer auth from key FILE, sorted by index, base-url override (issue #124)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-prov-'));
  try {
    const keyFile = path.join(dir, 'k.txt');
    fs.writeFileSync(keyFile, 'sk-test-key\n');
    const f = stubFetch((url, body) => {
      assert.ok(url.endsWith('/embeddings'), `openai endpoint, got ${url}`);
      // deliberately OUT of order — client must sort by `index`
      return [
        200,
        { data: body.input.map((t, i) => ({ index: body.input.length - 1 - i, embedding: new Array(9).fill(i) })) },
      ];
    });
    const emb = resolveExternalEmbedder({
      embedder: 'openai', model: 'text-embedding-3-small',
      baseUrl: 'https://api.example.com/v1', keyFile,
      fetchImpl: f,
    });
    const desc = await emb.descriptor();
    assert.equal(desc.dim, 9);
    const out = await emb.embedFn(['a', 'b'], 'query', desc, '', false);
    assert.equal(f.calls[0].headers.authorization, 'Bearer sk-test-key', 'key file → Bearer');
    // server sent them reversed (index 1 first); the client restores order:
    // the row carrying index 0 is the one whose payload was filled with i=1
    assert.equal(out[0][0], 1, 'row with index 0 comes first after sorting');
    assert.equal(out[1][0], 0, 'row with index 1 comes second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('providers: provider mismatch produces DIFFERENT fingerprints; local flow untouched (issue #124)', async () => {
  const fA = stubFetch(() => [200, { embeddings: [[1, 2]] }]);
  const fB = stubFetch(() => [200, { data: [{ index: 0, embedding: [1, 2, 3] }] }]);
  const ollama = resolveExternalEmbedder({ embedder: 'ollama', model: 'm', fetchImpl: fA });
  const openai = resolveExternalEmbedder({ embedder: 'openai', model: 'm', fetchImpl: fB });
  const dOllama = await ollama.descriptor();
  const dOpenai = await openai.descriptor();

  const fpOllama = embeddingAdapterFingerprint(dOllama);
  const fpOpenai = embeddingAdapterFingerprint(dOpenai);
  assert.notEqual(fpOllama, fpOpenai, 'provider switch invalidates stored vectors');

  // local default descriptor keeps its own fingerprint family (no provider id)
  const local = embeddingAdapterFingerprint({
    nativeDim: 768, queryPrefix: 'query: ', passagePrefix: 'passage: ', pooling: 'mean', normalize: true,
  });
  assert.notEqual(local, fpOllama);

  // HTTP error surfaces with status + truncated body
  const bad = resolveExternalEmbedder({
    embedder: 'ollama', model: 'x', fetchImpl: stubFetch(() => [500, { error: 'boom' }]),
  });
  await assert.rejects(() => bad.descriptor(), /HTTP 500/);
});

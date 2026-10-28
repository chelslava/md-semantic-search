import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, validateGlob, globToRegExp } from '../dist/core.js';
import { searchIndex, MAX_QUERY_LENGTH } from '../dist/search.js';
import { handleMcpRequest } from '../dist/mcp.js';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex } from '../dist/search.js';

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

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('assertSafePath: permits valid paths inside CWD and homedir', () => {
  const cwd = process.cwd();
  const safeCwdPath = assertSafePath(path.join(cwd, 'test'));
  assert.equal(safeCwdPath, path.resolve(cwd, 'test'));
});

test('assertSafePath: rejects path traversal outside allowed root directories', () => {
  const root = path.parse(process.cwd()).root;
  const outsidePath = path.join(root, 'some_external_unallowed_dir_12345');
  
  // Set explicit MDSS_ROOT_GUARD
  const origGuard = process.env.MDSS_ROOT_GUARD;
  try {
    process.env.MDSS_ROOT_GUARD = process.cwd();
    assert.throws(
      () => assertSafePath(outsidePath),
      /path traversal guard/
    );
  } finally {
    if (origGuard === undefined) delete process.env.MDSS_ROOT_GUARD;
    else process.env.MDSS_ROOT_GUARD = origGuard;
  }
});

test('validateGlob: accepts valid glob patterns and rejects forbidden regex injection characters', () => {
  assert.equal(validateGlob('docs/**/*.md'), 'docs/**/*.md');
  assert.equal(validateGlob('notes/file-*.txt'), 'notes/file-*.txt');

  assert.throws(() => globToRegExp('docs/(illegal)'), /forbidden character "\("/);
  assert.throws(() => globToRegExp('notes|other'), /forbidden character "\|"/);
  assert.throws(() => globToRegExp('file$.md'), /forbidden character "\$"/);
  assert.throws(() => globToRegExp('dir{1,2}'), /forbidden character "\{"/);
});

test('MAX_QUERY_LENGTH: searchIndex rejects oversized queries > 2048 chars', async () => {
  const dummyIndex = {
    schemaVersion: 3,
    chunks: [],
    lexical: { format: 'bm25-v2', documentLengths: [], postings: {} },
  };
  const loaded = { index: dummyIndex, model: { id: 'dummy', dim: 384 } };

  const oversizedQuery = 'a'.repeat(MAX_QUERY_LENGTH + 1);
  await assert.rejects(
    async () => searchIndex({ loaded, query: oversizedQuery, cacheDir: '' }),
    /query exceeds maximum length of 2048 characters/
  );
});

test('MCP search_markdown: vaults argument is root-guarded (issue #179)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-vault-guard-'));
  const dir = path.join(root, 'vault');
  const idx = path.join(dir, '.mdss');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.md'), '# Notes\n\n## Alpha\n\nalpha content note about search indexing and ranking semantics\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
  const loaded = loadIndex(idx);
  const state = { loaded, cacheDir: path.join(root, 'daemon-cache'), offline: true, embedFn: fakeEmbed };

  const callVaults = (vaults) =>
    handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_markdown', arguments: { query: 'alpha', vaults } },
      },
      state,
    );

  try {
    // relative traversal out of the daemon's vault -> traversal-guard error
    const parentRes = await callVaults(['..']);
    assert.equal(parentRes.result.isError, true);
    assert.match(parentRes.result.content[0].text, /path traversal guard/);

    // tmpdir HOSTS the fixture, but is itself outside the vault root
    const tmpRes = await callVaults([os.tmpdir()]);
    assert.equal(tmpRes.result.isError, true);
    assert.match(tmpRes.result.content[0].text, /path traversal guard/);

    // a real directory outside the trust domain: rejected, nothing written there
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const outsideRes = await callVaults([outside]);
    assert.equal(outsideRes.result.isError, true);
    assert.match(outsideRes.result.content[0].text, /path traversal guard/);
    assert.equal(fs.existsSync(path.join(outside, '.cache')), false, 'no query-cache written outside the daemon');
    assert.equal(fs.existsSync(path.join(outside, '.mdss')), false, 'no index side effects outside the daemon');

    // explicit indexDir is guarded with the same roots
    const idxRes = await callVaults([{ path: dir, indexDir: path.join(root, 'outside', 'stolen-mdss') }]);
    assert.equal(idxRes.result.isError, true);
    assert.match(idxRes.result.content[0].text, /path traversal guard/);

    // MDSS_ROOT_GUARD widens the trust domain
    const guarded = path.join(root, 'guarded-vault');
    fs.mkdirSync(guarded, { recursive: true });
    fs.writeFileSync(path.join(guarded, 'g.md'), '# Guarded\n\n## Gamma\n\nguarded gamma note with extra searchable body text for chunking\n');
    await buildIndex({
      db: guarded,
      indexDir: path.join(guarded, '.mdss'),
      cacheDir: state.cacheDir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });
    const origGuard = process.env.MDSS_ROOT_GUARD;
    try {
      process.env.MDSS_ROOT_GUARD = guarded;
      const widened = await callVaults([guarded]);
      assert.equal(widened.result.isError, undefined);
    } finally {
      if (origGuard === undefined) delete process.env.MDSS_ROOT_GUARD;
      else process.env.MDSS_ROOT_GUARD = origGuard;
    }

    // legitimate federation inside the daemon's own vault still works
    const sub = path.join(dir, 'subvault');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'sub.md'), '# Sub\n\n## Beta\n\nbeta sub vault note with extra searchable body text for chunking\n');
    await buildIndex({
      db: sub,
      indexDir: path.join(sub, '.mdss'),
      cacheDir: state.cacheDir,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });
    const okRes = await callVaults([dir, sub]);
    assert.equal(okRes.result.isError, undefined);
    const hits = JSON.parse(okRes.result.content[0].text);
    assert.ok(Array.isArray(hits) && hits.length > 0, 'federated hits returned');
    for (const h of hits) {
      assert.ok(['vault', 'subvault'].includes(h.vault), `vault attribution present, got ${h.vault}`);
    }

    // query-cache only in the daemon-owned cacheDir, never per-vault (#179)
    assert.equal(fs.existsSync(path.join(sub, '.cache')), false, 'no per-vault .cache invented');
    assert.equal(fs.existsSync(path.join(dir, '.cache')), false, 'no per-vault .cache invented');
  } finally {
    safeRm(root);
  }
});

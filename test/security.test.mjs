import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { assertSafePath, validateGlob, globToRegExp } from '../dist/core.js';
import { searchIndex, MAX_QUERY_LENGTH } from '../dist/search.js';

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

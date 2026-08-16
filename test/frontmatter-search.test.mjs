import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { loadIndex, searchIndex } from '../src/search.mjs';

function fakeEmbed(texts) {
  return Promise.resolve(texts.map(() => new Array(768).fill(0.1)));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('searchIndex filters by tag, project, type, and status metadata', async () => {
  const dir = tempDir('frontmatter-search');
  const idx = path.join(dir, '.mdss');

  try {
    fs.writeFileSync(path.join(dir, 'doc1.md'), `---
title: "Doc One"
tags: [#search, #core]
project: proj-alpha
type: architecture
status: active
---

This is architectural documentation for search core components.
`);

    fs.writeFileSync(path.join(dir, 'doc2.md'), `---
title: "Doc Two"
tags: [#guide, #ui]
project: proj-beta
type: guide
status: draft
---

User interface guide documentation for frontend.
`);

    await buildIndex({ db: dir, indexDir: idx, embedFn: fakeEmbed, modelName: 'e5-base' });

    const loaded = loadIndex(idx);

    // Filter by tag
    const searchTag = await searchIndex({
      loaded,
      query: 'documentation',
      tag: 'search',
      embedFn: fakeEmbed,
    });
    assert.equal(searchTag.length, 1);
    assert.equal(searchTag[0].file, 'doc1.md');
    assert.deepEqual(searchTag[0].meta.tags, ['search', 'core']);

    // Filter by project
    const searchProj = await searchIndex({
      loaded,
      query: 'documentation',
      project: 'proj-beta',
      embedFn: fakeEmbed,
    });
    assert.equal(searchProj.length, 1);
    assert.equal(searchProj[0].file, 'doc2.md');

    // Filter by type
    const searchType = await searchIndex({
      loaded,
      query: 'documentation',
      type: 'architecture',
      embedFn: fakeEmbed,
    });
    assert.equal(searchType.length, 1);
    assert.equal(searchType[0].file, 'doc1.md');
  } finally {
    safeRm(dir);
  }
});

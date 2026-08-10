import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Self-reference: Node resolves 'md-semantic-search' via the package.json
// "exports" map (no node_modules link needed) — this validates that the
// published package exposes the library API from a consumer's point of view.
// The named imports at the top ARE the exports-map test: a missing export
// fails the whole file at load time, so per-import typeof assertions would be
// tautological (issue #29) — only the value checks below carry information.
import {
  buildIndex, search, loadIndex, searchIndex,
  resolveModel, MODELS, DEFAULT_MODEL,
  tokenize, encodeVec, decodeVec, cosine, chunkHash,
} from 'md-semantic-search';

function fakeEmbed(texts) {
  return texts.map((t) => {
    const v = new Array(8).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % 8] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

test('exports map: package root exposes the library API (issue #14)', () => {
  // Value checks carry real information; the typeof checks were tautological
  // because the named import above already fails the file if a symbol is
  // missing (issue #29).
  assert.ok(MODELS['e5-base'], 'MODELS registry exposed');
  assert.equal(DEFAULT_MODEL, 'e5-base');
});

test('chunkHash: package facade preserves the legacy chunk input shape', () => {
  const model = resolveModel('e5-base');
  const legacyChunk = { title: 'Document', heading: 'Leaf', text: 'body' };

  const first = chunkHash(model, legacyChunk);
  const second = chunkHash(model, legacyChunk);
  const explicit = chunkHash(model, { ...legacyChunk, headingPath: ['Leaf'] });
  const blankHeading = { title: 'Document', heading: '  ', text: 'body' };

  assert.equal(first, second, 'legacy input hashes deterministically');
  assert.equal(first, explicit, 'legacy heading derives the equivalent one-segment path');
  assert.equal(
    chunkHash(model, blankHeading),
    chunkHash(model, { ...blankHeading, headingPath: [] }),
    'blank legacy heading derives an empty path',
  );
});

test('library: end-to-end index → search via the public API (issues #14+#2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-lib-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Sports\n\n## Hockey\n\nsports guide hockey match puck arena\n');

    const res = await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    assert.equal(res.files, 2);

    // one-shot path
    const hits = await search({ indexDir: idx, cacheDir: dir, query: 'coffee', k: 2, embedFn: fakeEmbed });
    assert.equal(hits[0].file, 'a.md');

    // cached path: load once, query many
    const loaded = loadIndex(idx);
    const q1 = await searchIndex({ loaded, cacheDir: dir, query: 'coffee', k: 2, embedFn: fakeEmbed });
    const q2 = await searchIndex({ loaded, cacheDir: dir, query: 'hockey', k: 2, embedFn: fakeEmbed });
    assert.equal(q1[0].file, 'a.md');
    assert.equal(q2[0].file, 'b.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

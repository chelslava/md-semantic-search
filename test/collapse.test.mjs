import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseResults } from '../src/collapse.mjs';

test('collapseResults limits items per document key', () => {
  const hits = [
    { file: 'doc1.md', score: 0.9, text: 'chunk 1' },
    { file: 'doc1.md', score: 0.8, text: 'chunk 2' },
    { file: 'doc2.md', score: 0.75, text: 'chunk 3' },
    { file: 'doc1.md', score: 0.7, text: 'chunk 4' },
    { file: 'doc2.md', score: 0.65, text: 'chunk 5' },
  ];

  const collapsed1 = collapseResults(hits, h => h.file, 1);
  assert.equal(collapsed1.length, 2);
  assert.equal(collapsed1[0].file, 'doc1.md');
  assert.equal(collapsed1[1].file, 'doc2.md');

  const collapsed2 = collapseResults(hits, h => h.file, 2);
  assert.equal(collapsed2.length, 4);
  assert.equal(collapsed2.filter(h => h.file === 'doc1.md').length, 2);
  assert.equal(collapsed2.filter(h => h.file === 'doc2.md').length, 2);
});

test('collapseResults respects canonical metadata over file path when present', () => {
  const hits = [
    { file: 'v1.md', score: 0.9, meta: { canonical: 'doc-canonical' } },
    { file: 'v2.md', score: 0.85, meta: { canonical: 'doc-canonical' } },
    { file: 'other.md', score: 0.8 },
  ];

  const collapsed = collapseResults(hits, h => h.meta?.canonical || h.file, 1);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].file, 'v1.md');
  assert.equal(collapsed[1].file, 'other.md');
});

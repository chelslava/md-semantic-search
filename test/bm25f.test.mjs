import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLexicalDocument, DEFAULT_FIELD_WEIGHTS, editDistance, fuzzyTitleAliasScores } from '../dist/lexical.js';

test('analyzeLexicalDocument applies BM25F field weights', () => {
  const chunk = {
    title: 'Semantic Search Guide',
    heading: 'Architecture',
    headingPath: ['Semantic Search Guide', 'Architecture'],
    text: 'Core search implementation notes.',
    meta: { aliases: ['Vector Search'], tags: ['search'] },
  };

  const freqs = analyzeLexicalDocument(chunk);
  assert.equal(freqs['semantic'], DEFAULT_FIELD_WEIGHTS.title + DEFAULT_FIELD_WEIGHTS.headingPath);
  assert.equal(freqs['vector'], DEFAULT_FIELD_WEIGHTS.aliases);
  assert.equal(freqs['notes'], DEFAULT_FIELD_WEIGHTS.body);
});

test('editDistance correctly computes Damerau-Levenshtein distance', () => {
  assert.equal(editDistance('search', 'search'), 0);
  assert.equal(editDistance('search', 'serach'), 1); // transposition
  assert.equal(editDistance('search', 'seach'), 1);  // deletion
  assert.equal(editDistance('search', 'searchs'), 1); // insertion
});

test('fuzzyTitleAliasScores matches typo-ridden query terms against title and aliases', () => {
  const chunks = [
    { file: 'doc1.md', title: 'Architecture Overview', meta: { aliases: ['System Design'] } },
    { file: 'doc2.md', title: 'User Manual', meta: { aliases: ['Guide Book'] } },
  ];

  // Query with typo "Architecure" (missing 't')
  const scores = fuzzyTitleAliasScores(chunks, 'Architecure');
  assert.ok(scores.has(0));
  assert.ok(!scores.has(1));
  assert.ok(scores.get(0) > 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLexicalDocument,
  bm25Scores,
  buildLexicalIndex,
  lexicalIdentity,
  matchingTerms,
  validateLexicalIndex,
} from '../src/lexical.mjs';

const chunk = (text, title = '', heading = '') => ({ title, heading, text });

test('lexical document: indexes ancestor terms once when title and leaf differ only by normalized case', () => {
  // Given: a heading path repeats the title and leaf with different case and edge whitespace.
  const contextualChunk = {
    title: ' Project Atlas ',
    heading: ' Recovery Runbook ',
    headingPath: ['project atlas', 'Operations', 'recovery runbook'],
    text: 'body signal',
  };

  // When: the chunk is analyzed as one lexical document.
  const frequencies = analyzeLexicalDocument(contextualChunk);

  // Then: the ancestor contributes terms without duplicating normalized title or leaf terms.
  assert.equal(frequencies.operations, 1.8);
  assert.equal(frequencies.project, 4.8); // Title (3.0) + HeadingPath (1.8)
  assert.equal(frequencies.atlas, 4.8);   // Title (3.0) + HeadingPath (1.8)
  assert.equal(frequencies.recovery, 1.8); // HeadingPath (1.8)
  assert.equal(frequencies.runbook, 1.8);  // HeadingPath (1.8)
});

test('BM25: rare terms have greater IDF than common terms', () => {
  const lexical = buildLexicalIndex([
    analyzeLexicalDocument(chunk('common rare')),
    analyzeLexicalDocument(chunk('common ordinary')),
    analyzeLexicalDocument(chunk('common routine')),
  ]);

  const rare = bm25Scores(lexical, ['rare']);
  const common = bm25Scores(lexical, ['common']);

  assert.ok(rare.get(0) > common.get(0));
});

test('BM25: term frequency saturates instead of scaling linearly', () => {
  const lexical = buildLexicalIndex([
    analyzeLexicalDocument(chunk('needle filler filler')),
    analyzeLexicalDocument(chunk('needle needle needle')),
  ]);

  const scores = bm25Scores(lexical, ['needle']);
  const single = scores.get(0);
  const repeated = scores.get(1);

  assert.ok(repeated > single);
  assert.ok(repeated < single * 3);
});

test('BM25: shorter documents score higher for the same term frequency', () => {
  const lexical = buildLexicalIndex([
    analyzeLexicalDocument(chunk('needle short')),
    analyzeLexicalDocument(chunk('needle long document with several extra terms')),
  ]);

  const scores = bm25Scores(lexical, ['needle']);

  assert.ok(scores.get(0) > scores.get(1));
});

test('lexical index preserves exact engineering identifiers and query order', () => {
  const lexical = buildLexicalIndex([
    analyzeLexicalDocument(chunk('C# C++ go io V8 runtime')),
  ]);

  assert.deepEqual(Object.keys(lexical.postings).sort(), ['c#', 'c++', 'go', 'io', 'runtime', 'v8']);
  assert.deepEqual(matchingTerms(lexical, ['v8', 'go', 'v8', 'c++'], 0), ['v8', 'go', 'c++']);
});

test('lexical validation enforces postings order, positive TF, and length sums', () => {
  const valid = {
    format: 'bm25-v1',
    documentLengths: [2, 1],
    postings: { alpha: [[0, 1], [1, 1]], beta: [[0, 1]] },
  };
  assert.equal(validateLexicalIndex(valid, 2), null);
  assert.match(validateLexicalIndex({ ...valid, documentLengths: [2] }, 2), /documentLengths/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[1, 1], [0, 1]] } }, 2), /strictly increasing/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[0, 0]] } }, 2), /positive TF/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[2, 1]] } }, 2), /out of range/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[0, 1]] } }, 2), /TF sum/);
});

test('lexical validation safely accepts arbitrary own-property terms', () => {
  const lexical = JSON.parse('{"format":"bm25-v1","documentLengths":[3],"postings":{"__proto__":[[0,1]],"constructor":[[0,1]],"toString":[[0,1]]}}');

  assert.equal(validateLexicalIndex(lexical, 1), null);
  assert.equal(bm25Scores(lexical, ['__proto__']).get(0) > 0, true);
});

test('lexical identity changes when an ancestor heading changes', () => {
  // Given: equivalent leaf chunks under two different ancestor headings.
  const titleHeading = { title: 'Same', heading: 'Same', headingPath: ['Same'], text: 'body' };
  const frontmatter = { title: 'Same', heading: '', headingPath: [], text: 'body' };
  const underParent = { ...titleHeading, headingPath: ['Parent', 'Same'] };
  const underRenamedParent = { ...titleHeading, headingPath: ['Renamed', 'Same'] };

  // When: their model-independent lexical identities are calculated.
  const parentIdentity = lexicalIdentity(underParent);
  const renamedParentIdentity = lexicalIdentity(underRenamedParent);

  // Then: leaf/title distinctions and ancestor context both affect lexical identity.
  assert.notEqual(lexicalIdentity(titleHeading), lexicalIdentity(frontmatter));
  assert.notEqual(parentIdentity, renamedParentIdentity);
});

test('lexical validation rejects unsafe integers and checked TF-sum overflow', () => {
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: ['invalid'], postings: {},
  }, 1), /documentLengths/);
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [1], postings: { term: [['invalid', 1]] },
  }, 1), /safe integer document ID/);
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [1], postings: { term: [[0, -1]] },
  }, 1), /positive TF/);
  assert.throws(() => bm25Scores({
    format: 'bm25-v1', documentLengths: [Infinity], postings: { term: [[0, 1]] },
  }, ['term']), /finite BM25/);
});

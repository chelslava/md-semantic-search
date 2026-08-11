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
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[0, 0]] } }, 2), /positive integer TF/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[2, 1]] } }, 2), /out of range/);
  assert.match(validateLexicalIndex({ ...valid, postings: { alpha: [[0, 1]] } }, 2), /TF sum/);
});

test('lexical validation safely accepts arbitrary own-property terms', () => {
  const lexical = JSON.parse('{"format":"bm25-v1","documentLengths":[3],"postings":{"__proto__":[[0,1]],"constructor":[[0,1]],"toString":[[0,1]]}}');

  assert.equal(validateLexicalIndex(lexical, 1), null);
  assert.equal(bm25Scores(lexical, ['__proto__']).get(0) > 0, true);
});

test('lexical identity follows title + leaf heading + text, never headingPath or model', () => {
  const titleHeading = { title: 'Same', heading: 'Same', headingPath: ['Same'], text: 'body' };
  const frontmatter = { title: 'Same', heading: '', headingPath: [], text: 'body' };

  assert.notEqual(lexicalIdentity(titleHeading), lexicalIdentity(frontmatter));
  assert.equal(
    lexicalIdentity({ ...titleHeading, headingPath: ['Parent', 'Same'] }),
    lexicalIdentity({ ...titleHeading, headingPath: ['Renamed', 'Same'] }),
  );
});

test('lexical validation rejects unsafe integers and checked TF-sum overflow', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [unsafe], postings: {},
  }, 1), /safe integer/);
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [1], postings: { term: [[unsafe, 1]] },
  }, 1), /safe integer document ID/);
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [1], postings: { term: [[0, unsafe]] },
  }, 1), /safe integer TF/);
  assert.match(validateLexicalIndex({
    format: 'bm25-v1', documentLengths: [Number.MAX_SAFE_INTEGER],
    postings: { first: [[0, Number.MAX_SAFE_INTEGER]], second: [[0, 1]] },
  }, 1), /TF sum exceeds/);
  assert.throws(() => bm25Scores({
    format: 'bm25-v1', documentLengths: [Infinity], postings: { term: [[0, 1]] },
  }, ['term']), /finite BM25/);
});

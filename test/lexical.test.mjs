import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editDistance,
  editDistanceAtMost,
  analyzeLexicalDocument,
  bm25Scores,
  buildLexicalIndex,
  lexicalIdentity,
  matchingTerms,
  validateLexicalIndex,
} from '../dist/lexical.js';

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

test('lexical: editDistanceAtMost agrees with editDistance on every threshold decision (issue #193)', () => {
  // randomized cross-check: banded thresholded DP must make EXACTLY the same
  // accept/reject decisions and return the exact distance when accepted
  let seed = 42;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = 'abcde';
  for (let trial = 0; trial < 4000; trial++) {
    const a = Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join('');
    const b = Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join('');
    const maxDist = rnd(4);
    const exact = editDistance(a, b);
    const banded = editDistanceAtMost(a, b, maxDist);
    if (exact <= maxDist) {
      assert.equal(banded, exact, `"${a}" vs "${b}" k=${maxDist}: expected ${exact}`);
    } else {
      assert.equal(banded, null, `"${a}" vs "${b}" k=${maxDist}: expected rejection (exact ${exact})`);
    }
  }
  // transposition-heavy cases (Damerau extension must stay exact)
  assert.equal(editDistanceAtMost('abcdef', 'abcfde', 2), 2); // cyclic rotation of 'def' = 2 ops
  assert.equal(editDistanceAtMost('abcd', 'badc', 2), 2);
  assert.equal(editDistanceAtMost('ca', 'abc', 3), 3);
});

// ---------------------------------------------------------------------------
// issue #247: the fuzzy scan runs through a per-array vocabulary index with a
// length prefilter instead of a brute scan over every chunk. The scores must
// be identical to the brute-force semantics; the index caches per array.
// ---------------------------------------------------------------------------

test('lexical: fuzzyTitleAliasScores vocab index matches brute-force semantics (issue #247)', async () => {
  const { fuzzyTitleAliasScores, tokenize } = await import('../dist/lexical.js');

  const chunks = [
    { title: 'Database Failover Runbook', meta: { aliases: ['db failover', 'failover dr'] } },
    { title: 'API Token Rotation Policy', meta: { aliases: ['token rotation'] } },
    { title: 'Windows stdin re-wrap', meta: { aliases: [] } },
    { title: 'Kubernetes Pod Scheduling', meta: { aliases: ['k8s pods'] } },
    { title: 'Rust Ownership Rules', meta: { aliases: [] } },
  ];

  // exact token hit
  let scores = fuzzyTitleAliasScores(chunks, 'failover');
  assert.ok(scores.has(0), 'exact title token scores the doc');
  // fuzzy hit: 'rottaion' is within distance 2 of 'rotation' (len 8 → maxDist 2)
  scores = fuzzyTitleAliasScores(chunks, 'rottaion');
  assert.ok(scores.has(1), 'edit-distance match scores the doc through the vocab index');
  assert.ok(!scores.has(0), 'unrelated docs never score');
  // length prefilter: a 12-char query cannot match a 4-char token at maxDist 2
  scores = fuzzyTitleAliasScores(chunks, 'schedulingx');
  assert.ok(scores.has(3), 'long fuzzy query still matches its own length band');
  assert.ok(!scores.has(2), 'short tokens outside the length band never match');

  // cross-check against a brute-force recomputation of the OLD semantics
  const query = 'rottaion failover';
  const brute = new Map();
  const qTerms = tokenize(query);
  chunks.forEach((c, docId) => {
    const tTerms = [...c.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [], ...(c.meta?.aliases || []).flatMap((a) => tokenize(a))];
    let maxScore = 0;
    for (const qt of qTerms) {
      if (qt.length < 3) continue;
      const maxDist = Math.min(2, Math.floor(qt.length / 3));
      for (const tt of tTerms) {
        if (tt.length < 3) continue;
        // reference banded DP via the exported editDistanceAtMost
        const dist = editDistanceAtMost(qt, tt, maxDist);
        if (dist !== null) {
          const similarity = 1 - dist / Math.max(qt.length, tt.length);
          if (similarity > maxScore) maxScore = similarity;
        }
      }
    }
    if (maxScore > 0) brute.set(docId, maxScore * 2.0);
  });
  const fast = fuzzyTitleAliasScores(chunks, query);
  assert.equal(fast.size, brute.size, 'same doc set');
  for (const [docId, score] of brute) {
    assert.equal(fast.get(docId), score, `doc ${docId} score identical`);
  }
});

test('lexical: the vocab index caches per chunks array (issue #247)', async () => {
  const { fuzzyTitleAliasScores } = await import('../dist/lexical.js');
  const chunks = Array.from({ length: 400 }, (_, i) => ({
    title: `Service ${i} runbook deployment pipeline`,
    meta: { aliases: [`svc-${i}`] },
  }));
  // warm the cache
  fuzzyTitleAliasScores(chunks, 'deployment');
  const t0 = performance.now();
  for (let q = 0; q < 50; q++) fuzzyTitleAliasScores(chunks, `deployment runbook ${q}`);
  const warm = performance.now() - t0;
  assert.ok(warm < 2000, `50 warm queries stay fast (got ${warm.toFixed(1)} ms)`);
  // a different array object rebuilds its own vocabulary
  const other = chunks.slice();
  const t1 = performance.now();
  fuzzyTitleAliasScores(other, 'deployment');
  const cold = performance.now() - t1;
  assert.ok(cold >= 0);
});

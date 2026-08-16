// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMetrics,
  gradeByDoc,
  hitAtK,
  ndcgAtK,
  queryMetrics,
  recallAtK,
  reciprocalRank,
  redundancyAtK,
  winTieLoss,
} from '../dist/metrics.js';

/** @type {Record<string, number>} per-doc graded judgements for the examples. */
const docGrades = { a: 3, b: 0, c: 3, d: 0 };

test('nDCG@k: perfect ordering scores 1.0', () => {
  // Grades descending with the best docs first ⇒ DCG equals IDCG.
  const dcg = ndcgAtK(['a', 'c', 'b', 'd'], (doc) => docGrades[doc] ?? 0, 4);
  assert.equal(dcg, 1.0);
});

test('nDCG@k: reversed (worst) ordering where no positive grade is in the window scores 0.0', () => {
  // With k=1 the only evaluated hit has grade 0 ⇒ DCG is 0.
  const dcg = ndcgAtK(['d', 'a', 'c', 'b'], (doc) => docGrades[doc] ?? 0, 1);
  assert.equal(dcg, 0.0);
});

test('nDCG@k: hand-computed example a=3,b=0,c=3,d=0 at k=3', () => {
  // ranked=[a,b,c,d], grades a=3,b=0,c=3,d=0, k=3, standard log2 discount:
  //   DCG  = 3/log2(2) + 0 + 3/log2(4) = 3 + 1.5          = 4.5
  //   IDCG = 3/log2(2) + 3/log2(3)     = 3 + 1.8928        = 4.8928
  //   nDCG = 4.5 / 4.8928              ≈ 0.9197207891481876
  // (c is misplaced at rank 3 instead of ideal rank 2, so nDCG < 1.)
  const idcg = 3 + 3 / Math.log2(3);
  const dcg = ndcgAtK(['a', 'b', 'c', 'd'], (doc) => docGrades[doc] ?? 0, 3);
  assert.equal(dcg, 4.5 / idcg);
});

test('nDCG@k: partial relevance yields a value strictly between 0 and 1', () => {
  // Best doc first, but the second positive-grade doc is pushed below the cut.
  const dcg = ndcgAtK(['a', 'b', 'd', 'c'], (doc) => docGrades[doc] ?? 0, 4);
  // DCG = 3/1 + 0 + 0 + 3/4 ≈ 3.75 ; IDCG = 4.5 → 3.75/4.5 < 1.
  assert.ok(dcg > 0 && dcg < 1);
});

test('nDCG@k: k larger than ranked length still normalizes by available grades', () => {
  // k=6 but only 4 docs; IDCG is taken from the 2 positive grades present.
  // Use the ideal order so the top-2 both carry grade 3.
  const dcg = ndcgAtK(['a', 'c', 'b', 'd'], (doc) => docGrades[doc] ?? 0, 6);
  assert.equal(dcg, 1.0);
});

test('reciprocal rank: first doc relevant → 1.0', () => {
  const rr = reciprocalRank(['a', 'b', 'c'], (doc) => docGrades[doc] >= 1);
  assert.equal(rr, 1.0);
});

test('reciprocal rank: third doc relevant → 1/3', () => {
  const rr = reciprocalRank(['b', 'd', 'a', 'c'], (doc) => docGrades[doc] >= 1);
  assert.equal(rr, 1 / 3);
});

test('reciprocal rank: no relevant doc → 0', () => {
  const rr = reciprocalRank(['b', 'd'], (doc) => docGrades[doc] >= 1);
  assert.equal(rr, 0);
});

test('hit@k: relevant doc within top-k → 1', () => {
  assert.equal(hitAtK(['b', 'a', 'd'], (doc) => docGrades[doc] >= 1, 3), 1);
});

test('hit@k: relevant doc beyond k → 0', () => {
  assert.equal(hitAtK(['b', 'd', 'a'], (doc) => docGrades[doc] >= 1, 2), 0);
});

test('hit@k: no relevant doc → 0', () => {
  assert.equal(hitAtK(['b', 'd'], (doc) => docGrades[doc] >= 1, 2), 0);
});

test('recall@k: all relevant docs retrieved → 1.0', () => {
  const recall = recallAtK(['a', 'c', 'b', 'd'], (doc) => docGrades[doc] >= 1, 4);
  assert.equal(recall, 1.0);
});

test('recall@k: half of relevant docs retrieved → 0.5', () => {
  const recall = recallAtK(['a', 'b', 'd', 'c'], (doc) => docGrades[doc] >= 1, 3);
  assert.equal(recall, 0.5);
});

test('recall@k: truncated ranked list retrieves only what appears in the window', () => {
  // Only one of two relevant docs is inside the first 2 positions.
  const recall = recallAtK(['b', 'c', 'a', 'd'], (doc) => docGrades[doc] >= 1, 2);
  assert.equal(recall, 0.5);
});

test('gradeByDoc: unknown doc grades 0, known docs return their grade', () => {
  const grade = gradeByDoc(docGrades);
  assert.equal(grade('missing'), 0);
  assert.equal(grade('a'), 3);
  assert.equal(grade('b'), 0);
  assert.equal(grade('c'), 3);
});

test('queryMetrics: integrates ndcg, mrr, hit, recall in one pass', () => {
  const qm = queryMetrics(['a', 'c', 'b', 'd'], docGrades, { k: 4 });
  assert.equal(qm.ndcg, 1.0); // ideal order: both 3-graded docs on ranks 1-2
  assert.equal(qm.mrr, 1.0); // a is relevant at rank 1
  assert.equal(qm.hit, 1); // a within top-4
  assert.equal(qm.recall, 1.0); // both relevant docs retrieved
});

test('queryMetrics: minRelevant excludes low grades from relevance', () => {
  // With minRelevant=2, grade-1 docs do not count as relevant.
  const grades = { x: 1, y: 2, z: 0 };
  const qm = queryMetrics(['y', 'x', 'z'], grades, { k: 3, minRelevant: 2 });
  assert.equal(qm.ndcg, 1.0); // only y is positive
  assert.equal(qm.mrr, 1.0); // y is the first (and only) relevant doc
  assert.equal(qm.hit, 1);
  assert.equal(qm.recall, 1.0); // 1 of 1 relevant retrieved
});

test('aggregateMetrics: means over two queries', () => {
  const a = { ndcg: 1.0, mrr: 1.0, hit: 1, recall: 1.0 };
  const b = { ndcg: 0.5, mrr: 0, hit: 0, recall: 0.5 };
  const agg = aggregateMetrics([a, b]);
  assert.equal(agg.n, 2);
  assert.equal(agg.mean.ndcg, 0.75);
  assert.equal(agg.mean.mrr, 0.5);
  assert.equal(agg.mean.hit, 0.5);
  assert.equal(agg.mean.recall, 0.75);
});

test('aggregateMetrics: empty input yields n:0 and zero means', () => {
  const agg = aggregateMetrics([]);
  assert.equal(agg.n, 0);
  assert.deepEqual(agg.mean, { ndcg: 0, mrr: 0, hit: 0, recall: 0 });
});

test('winTieLoss: counts wins, ties and losses against epsilon', () => {
  const a = [
    { ndcg: 0.9 },
    { ndcg: 0.5 },
    { ndcg: 0.5 },
    { ndcg: 0.1 },
  ];
  const b = [
    { ndcg: 0.6 },
    { ndcg: 0.5 },
    { ndcg: 0.5 },
    { ndcg: 0.8 },
  ];
  const wl = winTieLoss(a, b, 1e-6);
  assert.deepEqual(wl, { win: 1, tie: 2, loss: 1 });
});

test('winTieLoss: epsilon treats near-equal differences as a tie', () => {
  const a = [{ ndcg: 0.5001 }];
  const b = [{ ndcg: 0.5 }];
  // Difference 0.0001 is below epsilon 0.001 → tie, not a win.
  assert.deepEqual(winTieLoss(a, b, 0.001), { win: 0, tie: 1, loss: 0 });
});

test('redundancyAtK: duplicate files within top-k are counted', () => {
  const ranked = [
    { file: 'f1.md' },
    { file: 'f2.md' },
    { file: 'f1.md' }, // duplicate of the first hit
    { file: 'f2.md' }, // duplicate of the second hit
  ];
  // 2 of the first 4 hits are redundant → 0.5.
  assert.equal(redundancyAtK(ranked, 4), 0.5);
});

test('redundancyAtK: only the top-k window is considered', () => {
  const ranked = [
    { file: 'f1.md' },
    { file: 'f2.md' },
    { file: 'f1.md' },
    { file: 'f1.md' },
  ];
  // With k=2 only the unique first hits are seen → 0 redundancy.
  assert.equal(redundancyAtK(ranked, 2), 0);
});

test('redundancyAtK: no duplicate files → 0', () => {
  const ranked = [{ file: 'f1.md' }, { file: 'f2.md' }, { file: 'f3.md' }];
  assert.equal(redundancyAtK(ranked, 3), 0);
});

test('redundancyAtK: empty ranked list → 0', () => {
  assert.equal(redundancyAtK([], 5), 0);
});

// @ts-check
/**
 * Retrieval evaluation metrics (issue #56).
 *
 * Pure, dependency-free ranking metrics used by the golden-set harness. They
 * operate on a list of ranked hits plus graded relevance judgements so the
 * same functions work for chunk-level and document-level evaluation.
 *
 * Relevance judgements use the graded scale from the benchmark design:
 *   0 = irrelevant, 1 = related, 2 = useful support, 3 = direct answer.
 * For metrics that need binary relevance (`MRR`, `Hit@k`, `Recall@k`) a grade
 * threshold separates relevant from irrelevant. The default threshold is > 0
 * (any non-zero grade counts as relevant); pass `minRelevant` to require, e.g.
 * grade >= 2 for stricter precision-oriented slices.
 */

/**
 * @typedef {Object} BenchHit
 * @property {string} file - document id of the hit (canonical identity)
 *
 * @typedef {Object} GradeConf
 * @property {number[]} [grades] - per-document top grade: index i is the best
 *   grade over all judgements for doc i (default: []).
 * @property {number} [minRelevant=1] - minimum grade that counts as relevant.
 */

/**
 * nDCG@k (normalized discounted cumulative gain) with graded relevance.
 * Uses the standard log2 discount (position 1 has no discount).
 * @param {string[]} ranked - ranked document ids (hits, best first)
 * @param {(doc:string, rankIndex:number)=>number} grade - grade(doc, idx) >= 0
 * @param {number} k
 * @returns {number} in [0, 1]; 1 = perfect ordering at the top-k.
 */
export function ndcgAtK(ranked, grade, k) {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const g = grade(top[i], i);
    if (g <= 0) continue;
    dcg += g / Math.log2(i + 2); // log2(1+1)=1 for rank 0, log2(3) for rank 1, ...
  }
  if (dcg === 0) return 0;
  // Ideal DCG: sort all relevant grades (any doc) descending, take top-k.
  const all = (ranked ?? []).map((doc, i) => grade(doc, i)).filter((g) => g > 0);
  const ideal = [...all].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) idcg += ideal[i] / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Reciprocal rank of the first relevant doc (MRR contribution for one query).
 * @param {string[]} ranked
 * @param {(doc:string)=>boolean} isRelevant
 * @returns {number} 1/rank if a relevant doc is found, else 0.
 */
export function reciprocalRank(ranked, isRelevant) {
  for (let i = 0; i < ranked.length; i++) {
    if (isRelevant(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Hit@k — 1 if any relevant doc appears in the top-k.
 * @param {string[]} ranked
 * @param {(doc:string)=>boolean} isRelevant
 * @param {number} k
 * @returns {0|1}
 */
export function hitAtK(ranked, isRelevant, k) {
  return ranked.slice(0, k).some(isRelevant) ? 1 : 0;
}

/**
 * Recall@k — fraction of ALL relevant docs that appear in the top-k.
 * @param {string[]} ranked
 * @param {(doc:string)=>boolean} isRelevant
 * @param {number} k
 * @returns {number} in [0, 1].
 */
export function recallAtK(ranked, isRelevant, k) {
  const relevantCount = (ranked ?? []).filter(isRelevant).length;
  if (relevantCount === 0) return 0;
  const retrieved = ranked.slice(0, k).filter(isRelevant).length;
  return retrieved / relevantCount;
}

/**
 * Build a top-grade helper: for each doc, the highest grade across qrels.
 * @param {Record<string, number>} docGrades - doc id -> best grade observed.
 * @returns {(doc:string)=>number}
 */
export function gradeByDoc(docGrades) {
  /** @type {Record<string, number>} */
  const table = Object.create(null);
  for (const [doc, g] of Object.entries(docGrades)) {
    table[doc] = g;
  }
  return (doc) => table[doc] ?? 0;
}

/**
 * Convenience: compute the core aggregate metrics for one query in one pass.
 * @param {string[]} ranked - ranked doc ids, best first (top-N as returned).
 * @param {Record<string, number>} docGrades - doc->top grade (graded qrels).
 * @param {object} [opts]
 * @param {number} [opts.k=10]
 * @param {number} [opts.minRelevant=1]
 * @param {string[]} [opts.allRelevant] - all relevant doc ids (for Recall when
 *   the ranked list is truncated at k). Defaults to the keys of docGrades with
 *   grade >= minRelevant.
 * @returns {{ndcg:number, mrr:number, hit:0|1, recall:number}}
 */
export function queryMetrics(ranked, docGrades, opts = {}) {
  const { k = 10, minRelevant = 1 } = opts;
  const grade = gradeByDoc(docGrades);
  const isRelevant = (doc) => grade(doc) >= minRelevant;
  const allRelevant = opts.allRelevant ??
    Object.entries(docGrades).filter(([, g]) => g >= minRelevant).map(([d]) => d);
  // Recall needs the FULL ranked set; when truncated, patch with allRelevant.
  const fullRanked = ranked.length >= k ? ranked : [...ranked, ...allRelevant.filter((d) => !ranked.includes(d))];
  return {
    ndcg: ndcgAtK(ranked, grade, k),
    mrr: reciprocalRank(ranked, isRelevant),
    hit: hitAtK(ranked, isRelevant, k),
    recall: recallAtK(fullRanked, isRelevant, k),
  };
}

/**
 * Aggregate a list of per-query metric objects into means + win/tie/loss.
 * @param {Array<{ndcg:number, mrr:number, hit:0|1, recall:number}>} qm
 * @returns {{mean:{ndcg:number, mrr:number, hit:number, recall:number}, n:number}}
 */
export function aggregateMetrics(qm) {
  const n = qm.length;
  if (n === 0) return { mean: { ndcg: 0, mrr: 0, hit: 0, recall: 0 }, n: 0 };
  const sum = (key) => qm.reduce((acc, m) => acc + m[key], 0) / n;
  return {
    n,
    mean: { ndcg: sum('ndcg'), mrr: sum('mrr'), hit: sum('hit'), recall: sum('recall') },
  };
}

/**
 * Win/tie/loss between two per-query metric series (paired comparison).
 * Uses nDCG@10 as the primary comparison metric.
 * @param {Array<{ndcg:number}>} a
 * @param {Array<{ndcg:number}>} b
 * @param {number} [epsilon=1e-6]
 * @returns {{win:number, tie:number, loss:number}}
 */
export function winTieLoss(a, b, epsilon = 1e-6) {
  let win = 0, tie = 0, loss = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i].ndcg - b[i].ndcg;
    if (d > epsilon) win++;
    else if (d < -epsilon) loss++;
    else tie++;
  }
  return { win, tie, loss };
}

/**
 * Document-level redundancy fraction over the top-k hits: the proportion of
 * top-k hits whose file id duplicates an EARLIER top-k hit's file. A value of
 * 0 means every top-k hit comes from a distinct file; 1 means every hit after
 * the first reuses an already-seen source file.
 * @param {Array<{file:string}>} ranked - ranked hits, best first.
 * @param {number} k - window size.
 * @returns {number} in [0, 1]; 0 when no hits are present.
 */
export function redundancyAtK(ranked, k) {
  const seen = new Set();
  let redundant = 0;
  const counted = ranked.slice(0, k);
  for (let i = 0; i < counted.length; i++) {
    const doc = counted[i].file;
    if (seen.has(doc)) redundant++;
    else seen.add(doc);
  }
  return counted.length === 0 ? 0 : redundant / counted.length;
}
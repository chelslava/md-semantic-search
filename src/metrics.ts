/**
 * Retrieval evaluation metrics (issue #56).
 * Pure, dependency-free ranking metrics used by the golden-set harness.
 */

export interface BenchHit {
  file: string;
}

export interface GradeConf {
  grades?: number[];
  minRelevant?: number;
}

export interface MetricValues {
  ndcg: number;
  mrr: number;
  hit: number;
  recall: number;
}

export function ndcgAtK(
  ranked: string[],
  grade: (doc: string, rankIndex: number) => number,
  k: number
): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const g = grade(top[i], i);
    if (g <= 0) continue;
    dcg += g / Math.log2(i + 2);
  }
  if (dcg === 0) return 0;
  const all = (ranked ?? []).map((doc, i) => grade(doc, i)).filter((g) => g > 0);
  const ideal = [...all].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) idcg += ideal[i] / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function reciprocalRank(
  ranked: string[],
  isRelevant: (doc: string) => boolean
): number {
  for (let i = 0; i < ranked.length; i++) {
    if (isRelevant(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function hitAtK(
  ranked: string[],
  isRelevant: (doc: string) => boolean,
  k: number
): 0 | 1 {
  return ranked.slice(0, k).some(isRelevant) ? 1 : 0;
}

export function recallAtK(
  ranked: string[],
  isRelevant: (doc: string) => boolean,
  k: number
): number {
  const relevantCount = (ranked ?? []).filter(isRelevant).length;
  if (relevantCount === 0) return 0;
  const retrieved = ranked.slice(0, k).filter(isRelevant).length;
  return retrieved / relevantCount;
}

export function gradeByDoc(docGrades: Record<string, number>): (doc: string) => number {
  const table: Record<string, number> = Object.create(null);
  for (const [doc, g] of Object.entries(docGrades)) {
    table[doc] = g;
  }
  return (doc) => table[doc] ?? 0;
}

export function queryMetrics(
  ranked: string[],
  docGrades: Record<string, number>,
  opts: { k?: number; minRelevant?: number; allRelevant?: string[] } = {}
): MetricValues {
  const { k = 10, minRelevant = 1 } = opts;
  const grade = gradeByDoc(docGrades);
  const isRelevant = (doc: string) => grade(doc) >= minRelevant;
  const allRelevant = opts.allRelevant ?? Object.entries(docGrades).filter(([, g]) => g >= minRelevant).map(([d]) => d);
  const fullRanked = ranked.length >= k ? ranked : [...ranked, ...allRelevant.filter((d) => !ranked.includes(d))];
  return {
    ndcg: ndcgAtK(ranked, grade, k),
    mrr: reciprocalRank(ranked, isRelevant),
    hit: hitAtK(ranked, isRelevant, k),
    recall: recallAtK(fullRanked, isRelevant, k),
  };
}

export function aggregateMetrics(qm: MetricValues[]): { mean: MetricValues; n: number } {
  const n = qm.length;
  if (n === 0) return { mean: { ndcg: 0, mrr: 0, hit: 0, recall: 0 }, n: 0 };
  const sum = (key: keyof MetricValues) => qm.reduce((acc, m) => acc + m[key], 0) / n;
  return {
    n,
    mean: { ndcg: sum('ndcg'), mrr: sum('mrr'), hit: sum('hit'), recall: sum('recall') },
  };
}

export function winTieLoss(
  a: Array<{ ndcg: number }>,
  b: Array<{ ndcg: number }>,
  epsilon: number = 1e-6
): { win: number; tie: number; loss: number } {
  let win = 0,
    tie = 0,
    loss = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i].ndcg - b[i].ndcg;
    if (d > epsilon) win++;
    else if (d < -epsilon) loss++;
    else tie++;
  }
  return { win, tie, loss };
}

export function redundancyAtK(ranked: Array<{ file: string }>, k: number): number {
  const seen = new Set<string>();
  let redundant = 0;
  const counted = ranked.slice(0, k);
  for (let i = 0; i < counted.length; i++) {
    const doc = counted[i].file;
    if (seen.has(doc)) redundant++;
    else seen.add(doc);
  }
  return counted.length === 0 ? 0 : redundant / counted.length;
}

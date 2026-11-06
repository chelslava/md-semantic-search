import crypto from 'node:crypto';
import { DocumentMetadata } from './frontmatter.js';

export type TermFrequencies = Record<string, number>;

export interface LexicalIndex {
  format: 'bm25-v1' | 'bm25-v2';
  documentLengths: number[];
  postings: Record<string, Array<[number, number]>>;
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'has', 'with', 'this', 'that', 'from',
  'not', 'but', 'you', 'your', 'can', 'all', 'any', 'its',
  'все', 'как', 'что', 'это', 'при', 'для', 'или', 'был', 'без', 'над',
  'под', 'так', 'его', 'нет', 'есть',
  'of', 'to', 'in', 'on', 'it', 'is', 'at', 'by', 'be', 'we', 'us', 'he',
  'as', 'or', 'an', 'do', 'so', 'no', 'if', 'up', 'my', 'me', 'am',
  'по', 'от', 'из', 'на', 'за', 'во', 'со', 'не', 'ни', 'же', 'ли', 'бы',
  'уж', 'мы', 'вы', 'он', 'то', 'но', 'до', 'ко',
]);

export const _lexicalStats = { documentsAnalyzed: 0 };

function normalize(text?: string): string {
  return (text ?? '').replace(/\r\n?/g, '\n').trim();
}

function equivalent(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export interface ChunkForLexical {
  title: string;
  heading: string;
  headingPath?: string[];
  text: string;
  meta?: DocumentMetadata;
  file?: string;
}

export function lexicalDocument(chunk: ChunkForLexical): string {
  const title = normalize(chunk.title);
  const heading = normalize(chunk.heading);
  const ancestors = (chunk.headingPath ?? (heading ? [chunk.heading] : [])).map(normalize);
  if (ancestors.length > 0 && equivalent(ancestors[0], title)) ancestors.shift();
  if (ancestors.length > 0 && equivalent(ancestors[ancestors.length - 1], heading)) ancestors.pop();
  return [title, ...ancestors, heading, normalize(chunk.text)].join('\n');
}

export function lexicalIdentity(chunk: ChunkForLexical): string {
  return crypto.createHash('sha256').update(lexicalDocument(chunk)).digest('hex');
}

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}#+-]*/gu);
  if (!matches) return [];
  return matches.filter((term) => term.length > 1 && !STOP.has(term));
}

export const DEFAULT_FIELD_WEIGHTS = {
  title: 3.0,
  aliases: 3.0,
  headingPath: 1.8,
  body: 1.0,
};

export function analyzeLexicalDocument(
  chunk: ChunkForLexical,
  weights = DEFAULT_FIELD_WEIGHTS
): TermFrequencies {
  _lexicalStats.documentsAnalyzed++;
  const frequencies: TermFrequencies = Object.create(null);

  const titleText = chunk.title || '';
  const aliasesText = (chunk.meta?.aliases || []).join(' ');
  const headingText = (chunk.headingPath || [chunk.heading]).join(' ');
  const bodyText = chunk.text || '';

  const addTokens = (text: string, weight: number) => {
    for (const term of tokenize(text)) {
      frequencies[term] = (frequencies[term] ?? 0) + weight;
    }
  };

  addTokens(titleText, weights.title);
  if (aliasesText) addTokens(aliasesText, weights.aliases);
  if (headingText) addTokens(headingText, weights.headingPath);
  addTokens(bodyText, weights.body);

  return frequencies;
}

export function buildLexicalIndex(records: TermFrequencies[]): LexicalIndex {
  const postings: Record<string, Array<[number, number]>> = Object.create(null);
  const documentLengths = records.map((record, docId) => {
    let length = 0;
    for (const [term, tf] of Object.entries(record)) {
      length += tf;
      const posting = postings[term] ?? [];
      posting.push([docId, tf]);
      postings[term] = posting;
    }
    return Number(length.toFixed(3));
  });
  return { format: 'bm25-v2', documentLengths, postings };
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;

  const matrix = Array.from({ length: alen + 1 }, () => new Array(blen + 1).fill(0));
  for (let i = 0; i <= alen; i++) matrix[i][0] = i;
  for (let j = 0; j <= blen; j++) matrix[0][j] = j;

  for (let i = 1; i <= alen; i++) {
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }
  return matrix[alen][blen];
}

/**
 * Damerau-Levenshtein distance with a threshold (issue #193): banded DP that
 * never leaves the |i-j| <= maxDist diagonal and aborts as soon as the whole
 * row exceeds the threshold — O(maxDist × min(alen, blen)) instead of the
 * full O(alen × blen) matrix. Returns the EXACT distance when it is
 * <= maxDist and null otherwise; decisions are identical to
 * `editDistance(a, b) <= maxDist` (optimal paths within the threshold never
 * leave the band).
 */
export function editDistanceAtMost(a: string, b: string, maxDist: number): number | null {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (Math.abs(alen - blen) > maxDist) return null;
  if (alen === 0) return blen <= maxDist ? blen : null;
  if (blen === 0) return alen <= maxDist ? alen : null;
  if (maxDist < 0) return null;

  const INF = maxDist + 1;
  // rows are padded with an INF sentinel column on each side so band-edge
  // lookups (j-1 / j+1) never read a real out-of-band value
  const width = blen + 3;
  const rowA = new Int32Array(width);
  const rowB = new Int32Array(width);
  const rowC = new Int32Array(width);
  let prev2: Int32Array<ArrayBuffer> | null = null; // row i-2 (for transpositions)
  let prev: Int32Array<ArrayBuffer> = rowA;
  let cur: Int32Array<ArrayBuffer> = rowB;
  const scratch: Int32Array<ArrayBuffer> = rowC;
  for (let j = 1; j <= blen + 1; j++) prev[j] = j; // row 0: dp[0][j] = j (col 0 unused sentinel)
  prev[0] = 0;

  for (let i = 1; i <= alen; i++) {
    const jLo = Math.max(1, i - maxDist);
    const jHi = Math.min(blen, i + maxDist);
    cur[0] = i; // dp[i][0] = i (column 0 inside the band only when i <= maxDist)
    if (i > maxDist) cur[0] = INF;
    let rowMin = cur[0];
    for (let j = jLo; j <= jHi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && prev2 !== null) {
        v = Math.min(v, prev2[j - 2] + cost);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // band-out cells stay INF for this row
    for (let j = 1; j <= blen; j++) {
      if (j < jLo || j > jHi) cur[j] = INF;
    }
    if (rowMin > maxDist) return null;
    // three-row rotation: prev2 <- row(i-1), prev <- row(i), cur <- freed row
    const free = prev2 ?? scratch;
    prev2 = prev;
    prev = cur;
    cur = free;
  }
  const d = prev[blen];
  return d <= maxDist ? d : null;
}

/**
 * issue #193: target tokenization memoized per chunk object — the fuzzy scan
 * runs on every query, but a chunk's title/aliases tokenize to the same tokens
 * every time. WeakMap so runtime chunks (stable objects in serve) pay once.
 */
const fuzzyTargetTokens = new WeakMap<object, string[]>();

function targetTokens(chunk: { title: string; meta?: DocumentMetadata }): string[] {
  let tokens = fuzzyTargetTokens.get(chunk);
  if (!tokens) {
    const targets = [chunk.title, ...(chunk.meta?.aliases || [])].filter(Boolean);
    tokens = targets.flatMap((t) => tokenize(t));
    fuzzyTargetTokens.set(chunk, tokens);
  }
  return tokens;
}

// issue #247: per-chunks-array vocabulary for the fuzzy scan. The brute scan
// ran query tokens × EVERY chunk's title tokens through the banded DP; the
// vocabulary approach scans only title tokens whose LENGTH can possibly match
// (|lenDiff| <= maxDist — anything else is rejected by editDistanceAtMost
// anyway) and resolves candidates through an exact-token inverted index.
// Cached on a WeakMap keyed by the chunks array — the search path passes the
// stable runtime.chunks, so one vocabulary per index generation.
interface FuzzyVocab {
  /** exact title token → doc ids containing it */
  byToken: Map<string, number[]>;
  /** title tokens grouped by length (for the bounded fuzzy scan) */
  byLength: Map<number, string[]>;
  /** the unique doc ids (dense scan fallback for length-3 boundary tokens) */
  docCount: number;
}

const fuzzyVocabCache = new WeakMap<object, FuzzyVocab>();

function fuzzyVocab(chunks: Array<{ title: string; meta?: DocumentMetadata }>): FuzzyVocab {
  let vocab = fuzzyVocabCache.get(chunks);
  if (vocab) return vocab;
  const byToken = new Map<string, number[]>();
  for (let docId = 0; docId < chunks.length; docId++) {
    for (const tt of new Set(targetTokens(chunks[docId]))) {
      let list = byToken.get(tt);
      if (!list) {
        list = [];
        byToken.set(tt, list);
      }
      list.push(docId);
    }
  }
  // length buckets over the UNIQUE vocabulary — pushing per-doc would store
  // the same token once per containing document and the scan would repeat
  // its DP work once per copy (found the hard way on a 50k-chunk fixture)
  const byLength = new Map<number, string[]>();
  for (const token of byToken.keys()) {
    let bucket = byLength.get(token.length);
    if (!bucket) {
      bucket = [];
      byLength.set(token.length, bucket);
    }
    bucket.push(token);
  }
  vocab = { byToken, byLength, docCount: chunks.length };
  fuzzyVocabCache.set(chunks, vocab);
  return vocab;
}

export function fuzzyTitleAliasScores(
  chunks: Array<{ file?: string; title: string; meta?: DocumentMetadata }>,
  query: string
): Map<number, number> {
  const scores = new Map<number, number>();
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return scores;
  const vocab = fuzzyVocab(chunks);
  const candidateDocs = new Set<number>();
  // per-doc best similarity across (query token, near title token) pairs
  const best = new Map<number, number>();
  const bump = (docId: number, similarity: number): void => {
    candidateDocs.add(docId);
    const prev = best.get(docId);
    if (prev === undefined || similarity > prev) best.set(docId, similarity);
  };

  for (const qt of qTerms) {
    if (qt.length < 3) continue;
    const maxDist = Math.min(2, Math.floor(qt.length / 3));
    // length prefilter: |lenDiff| > maxDist can never pass the banded DP
    for (let len = Math.max(3, qt.length - maxDist); len <= qt.length + maxDist; len++) {
      const bucket = vocab.byLength.get(len);
      if (!bucket) continue;
      for (const tt of bucket) {
        const dist = editDistanceAtMost(qt, tt, maxDist);
        if (dist === null) continue;
        const similarity = 1 - dist / Math.max(qt.length, tt.length);
        for (const docId of vocab.byToken.get(tt)!) bump(docId, similarity);
      }
    }
  }

  for (const docId of candidateDocs) {
    const similarity = best.get(docId)!;
    if (similarity > 0) scores.set(docId, similarity * 2.0);
  }
  return scores;
}

export function validateLexicalIndex(value: unknown, chunkCount: number): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'lexical must be an object';
  }
  const lexical = value as Record<string, unknown>;
  if (lexical.format !== 'bm25-v1' && lexical.format !== 'bm25-v2') {
    return 'unknown lexical format';
  }
  if (
    !Array.isArray(lexical.documentLengths) ||
    lexical.documentLengths.length !== chunkCount ||
    !lexical.documentLengths.every((length) => Number.isFinite(length) && length >= 0)
  ) {
    return `documentLengths must contain ${chunkCount} non-negative numbers`;
  }
  if (lexical.postings === null || typeof lexical.postings !== 'object' || Array.isArray(lexical.postings)) {
    return 'postings must be an object';
  }

  const sums = new Array(chunkCount).fill(0);
  for (const [term, rawPosting] of Object.entries(lexical.postings)) {
    if (!Array.isArray(rawPosting)) return `posting for ${term} must be an array`;
    let previous = -1;
    for (const entry of rawPosting) {
      if (!Array.isArray(entry) || entry.length !== 2) return `posting for ${term} has an invalid entry`;
      const [docId, tf] = entry;
      if (!Number.isSafeInteger(docId)) {
        return `posting for ${term} must have a safe integer document ID`;
      }
      if (docId < 0 || docId >= chunkCount) {
        return `posting for ${term} has a document ID out of range`;
      }
      if (docId <= previous) return `posting for ${term} document IDs must be strictly increasing`;
      if (!Number.isFinite(tf) || tf <= 0) return `posting for ${term} must have positive TF`;
      sums[docId] += tf;
      previous = docId;
    }
  }
  for (let docId = 0; docId < chunkCount; docId++) {
    if (Math.abs(sums[docId] - (lexical.documentLengths as number[])[docId]) > 1e-3) {
      return `document ${docId} TF sum does not equal documentLengths`;
    }
  }
  return null;
}

export function reverseLexicalIndex(lexical: LexicalIndex): TermFrequencies[] {
  const records: TermFrequencies[] = lexical.documentLengths.map(() => Object.create(null));
  for (const [term, posting] of Object.entries(lexical.postings)) {
    for (const [docId, tf] of posting) records[docId][term] = tf;
  }
  return records;
}

export function bm25Scores(
  lexical: LexicalIndex,
  queryTerms: string[],
  eligible?: Set<number>
): Map<number, number> {
  const scores = new Map<number, number>();
  const documentCount = lexical.documentLengths.length;
  if (documentCount === 0) return scores;
  const averageLength = lexical.documentLengths.reduce((sum, length) => sum + length, 0) / documentCount || 1;
  if (!Number.isFinite(averageLength)) throw new Error('non-finite BM25 average document length');
  for (const term of new Set(queryTerms)) {
    const posting = Object.prototype.hasOwnProperty.call(lexical.postings, term) ? lexical.postings[term] : undefined;
    if (!posting) continue;
    const idf = Math.log(1 + (documentCount - posting.length + 0.5) / (posting.length + 0.5));
    if (!Number.isFinite(idf)) throw new Error(`non-finite BM25 IDF for ${term}`);
    for (const [docId, tf] of posting) {
      if (eligible && !eligible.has(docId)) continue;
      const lengthRatio = lexical.documentLengths[docId] / averageLength;
      const score = (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + 0.75 * lengthRatio));
      if (!Number.isFinite(lengthRatio) || !Number.isFinite(score)) {
        throw new Error(`non-finite BM25 score for ${term}`);
      }
      scores.set(docId, (scores.get(docId) ?? 0) + score);
    }
  }
  return scores;
}

export function matchingTerms(lexical: LexicalIndex, queryTerms: string[], docId: number): string[] {
  const matches: string[] = [];
  for (const term of new Set(queryTerms)) {
    const posting = Object.prototype.hasOwnProperty.call(lexical.postings, term) ? lexical.postings[term] : undefined;
    if (posting?.some(([candidate]) => candidate === docId)) matches.push(term);
  }
  return matches;
}

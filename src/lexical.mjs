// @ts-check
import crypto from 'node:crypto';

/** @typedef {Record<string, number>} TermFrequencies */
/**
 * @typedef {Object} LexicalIndex
 * @property {'bm25-v1'} format
 * @property {number[]} documentLengths
 * @property {Record<string, Array<[number, number]>>} postings
 */

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

/** @param {{title:string, heading:string, text:string}} chunk */
export function lexicalDocument(chunk) {
  return `${chunk.title} ${chunk.heading} ${chunk.text}`;
}

/** Model-independent identity of the exact lexical document input. */
export function lexicalIdentity(chunk) {
  return crypto.createHash('sha256').update(lexicalDocument(chunk)).digest('hex');
}

/** @param {string} text @returns {string[]} */
export function tokenize(text) {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}#+-]*/gu);
  if (!matches) return [];
  return matches.filter(term => term.length > 1 && !STOP.has(term));
}

/**
 * @param {{title:string, heading:string, text:string}} chunk
 * @returns {TermFrequencies}
 */
export function analyzeLexicalDocument(chunk) {
  _lexicalStats.documentsAnalyzed++;
  /** @type {TermFrequencies} */
  const frequencies = Object.create(null);
  for (const term of tokenize(lexicalDocument(chunk))) {
    frequencies[term] = (frequencies[term] ?? 0) + 1;
  }
  return frequencies;
}

/** @param {TermFrequencies[]} records @returns {LexicalIndex} */
export function buildLexicalIndex(records) {
  /** @type {Record<string, Array<[number, number]>>} */
  const postings = Object.create(null);
  const documentLengths = records.map((record, docId) => {
    let length = 0;
    for (const [term, tf] of Object.entries(record)) {
      if (!Number.isSafeInteger(tf) || tf <= 0 || length > Number.MAX_SAFE_INTEGER - tf) {
        throw new Error('lexical term frequencies exceed safe integer bounds');
      }
      length += tf;
      const posting = postings[term] ?? [];
      posting.push([docId, tf]);
      postings[term] = posting;
    }
    return length;
  });
  return { format: 'bm25-v1', documentLengths, postings };
}

/**
 * @param {unknown} value
 * @param {number} chunkCount
 * @returns {string|null}
 */
export function validateLexicalIndex(value, chunkCount) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'lexical must be an object';
  }
  const lexical = /** @type {Record<string, unknown>} */ (value);
  if (lexical.format !== 'bm25-v1') return 'unknown lexical format';
  if (!Array.isArray(lexical.documentLengths) || lexical.documentLengths.length !== chunkCount ||
      !lexical.documentLengths.every(length => Number.isSafeInteger(length) && length >= 0)) {
    return `documentLengths must contain ${chunkCount} non-negative safe integers`;
  }
  if (lexical.postings === null || typeof lexical.postings !== 'object' ||
      Array.isArray(lexical.postings)) return 'postings must be an object';

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
      if (!Number.isSafeInteger(tf)) return `posting for ${term} must have a safe integer TF`;
      if (tf <= 0) return `posting for ${term} must have positive integer TF`;
      if (sums[docId] > Number.MAX_SAFE_INTEGER - tf) {
        return `document ${docId} TF sum exceeds safe integer bounds`;
      }
      sums[docId] += tf;
      previous = docId;
    }
  }
  for (let docId = 0; docId < chunkCount; docId++) {
    if (sums[docId] !== lexical.documentLengths[docId]) {
      return `document ${docId} TF sum does not equal documentLengths`;
    }
  }
  return null;
}

/** @param {LexicalIndex} lexical @returns {TermFrequencies[]} */
export function reverseLexicalIndex(lexical) {
  const records = lexical.documentLengths.map(() => /** @type {TermFrequencies} */ (Object.create(null)));
  for (const [term, posting] of Object.entries(lexical.postings)) {
    for (const [docId, tf] of posting) records[docId][term] = tf;
  }
  return records;
}

/**
 * @param {LexicalIndex} lexical
 * @param {string[]} queryTerms
 * @param {Set<number>} [eligible]
 * @returns {Map<number, number>}
 */
export function bm25Scores(lexical, queryTerms, eligible) {
  const scores = new Map();
  const documentCount = lexical.documentLengths.length;
  if (documentCount === 0) return scores;
  const averageLength = lexical.documentLengths.reduce((sum, length) => sum + length, 0) /
    documentCount || 1;
  if (!Number.isFinite(averageLength)) throw new Error('non-finite BM25 average document length');
  for (const term of new Set(queryTerms)) {
    const posting = Object.prototype.hasOwnProperty.call(lexical.postings, term)
      ? lexical.postings[term] : undefined;
    if (!posting) continue;
    const idf = Math.log(1 + (documentCount - posting.length + 0.5) / (posting.length + 0.5));
    if (!Number.isFinite(idf)) throw new Error(`non-finite BM25 IDF for ${term}`);
    for (const [docId, tf] of posting) {
      if (eligible && !eligible.has(docId)) continue;
      const lengthRatio = lexical.documentLengths[docId] / averageLength;
      const score = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * lengthRatio));
      if (!Number.isFinite(lengthRatio) || !Number.isFinite(score)) {
        throw new Error(`non-finite BM25 score for ${term}`);
      }
      scores.set(docId, (scores.get(docId) ?? 0) + score);
    }
  }
  return scores;
}

/** @param {LexicalIndex} lexical @param {string[]} queryTerms @param {number} docId */
export function matchingTerms(lexical, queryTerms, docId) {
  const matches = [];
  for (const term of new Set(queryTerms)) {
    const posting = Object.prototype.hasOwnProperty.call(lexical.postings, term)
      ? lexical.postings[term] : undefined;
    if (posting?.some(([candidate]) => candidate === docId)) matches.push(term);
  }
  return matches;
}

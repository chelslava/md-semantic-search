// @ts-check
import crypto from 'node:crypto';

/** @typedef {Record<string, number>} TermFrequencies */
/**
 * @typedef {Object} LexicalIndex
 * @property {'bm25-v1'|'bm25-v2'} format
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

/** Normalize lexical context consistently with canonical passage hashing. */
function normalize(text) {
  return (text ?? '').replace(/\r\n?/g, '\n').trim();
}

/** @param {string} left @param {string} right */
function equivalent(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

/** @param {{title:string, heading:string, headingPath?:string[], text:string}} chunk */
export function lexicalDocument(chunk) {
  const title = normalize(chunk.title);
  const heading = normalize(chunk.heading);
  const ancestors = (chunk.headingPath ?? (heading ? [chunk.heading] : [])).map(normalize);
  if (ancestors.length > 0 && equivalent(ancestors[0], title)) ancestors.shift();
  if (ancestors.length > 0 && equivalent(ancestors[ancestors.length - 1], heading)) ancestors.pop();
  return [title, ...ancestors, heading, normalize(chunk.text)].join('\n');
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
 * @param {{title:string, heading:string, headingPath?:string[], text:string}} chunk
 * @returns {TermFrequencies}
 */
/** Default field weights for BM25F */
export const DEFAULT_FIELD_WEIGHTS = {
  title: 3.0,
  aliases: 3.0,
  headingPath: 1.8,
  body: 1.0,
};

/**
 * Field-aware lexical analysis: tokenizes fields separately with BM25F weights.
 * @param {{title:string, heading:string, headingPath?:string[], text:string, meta?:import('./frontmatter.mjs').DocumentMetadata}} chunk
 * @param {typeof DEFAULT_FIELD_WEIGHTS} [weights=DEFAULT_FIELD_WEIGHTS]
 * @returns {TermFrequencies}
 */
export function analyzeLexicalDocument(chunk, weights = DEFAULT_FIELD_WEIGHTS) {
  _lexicalStats.documentsAnalyzed++;
  /** @type {TermFrequencies} */
  const frequencies = Object.create(null);

  const titleText = chunk.title || '';
  const aliasesText = (chunk.meta?.aliases || []).join(' ');
  const headingText = (chunk.headingPath || [chunk.heading]).join(' ');
  const bodyText = chunk.text || '';

  const addTokens = (text, weight) => {
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

/** @param {TermFrequencies[]} records @returns {LexicalIndex} */
export function buildLexicalIndex(records) {
  /** @type {Record<string, Array<[number, number]>>} */
  const postings = Object.create(null);
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

/**
 * Damerau-Levenshtein edit distance calculation.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
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
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }
  return matrix[alen][blen];
}

/**
 * Bounded fuzzy matching for title & aliases (Damerau-Levenshtein dist 1-2).
 * Returns map of docId -> fuzzyScore.
 * @param {Array<{file:string, title:string, meta?:import('./frontmatter.mjs').DocumentMetadata}>} chunks
 * @param {string} query
 * @returns {Map<number, number>}
 */
export function fuzzyTitleAliasScores(chunks, query) {
  const scores = new Map();
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return scores;

  for (let docId = 0; docId < chunks.length; docId++) {
    const c = chunks[docId];
    const targets = [c.title, ...(c.meta?.aliases || [])].filter(Boolean);
    let maxScore = 0;

    for (const target of targets) {
      const tTerms = tokenize(target);
      for (const qt of qTerms) {
        if (qt.length < 3) continue; // skip tiny query tokens
        for (const tt of tTerms) {
          if (tt.length < 3) continue;
          const maxDist = Math.min(2, Math.floor(qt.length / 3));
          const dist = editDistance(qt, tt);
          if (dist <= maxDist) {
            const similarity = 1 - dist / Math.max(qt.length, tt.length);
            if (similarity > maxScore) maxScore = similarity;
          }
        }
      }
    }

    if (maxScore > 0) {
      scores.set(docId, maxScore * 2.0); // Bounded fuzzy title/alias boost
    }
  }
  return scores;
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
  if (lexical.format !== 'bm25-v1' && lexical.format !== 'bm25-v2') {
    return 'unknown lexical format';
  }
  if (!Array.isArray(lexical.documentLengths) || lexical.documentLengths.length !== chunkCount ||
      !lexical.documentLengths.every(length => Number.isFinite(length) && length >= 0)) {
    return `documentLengths must contain ${chunkCount} non-negative numbers`;
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
      if (!Number.isFinite(tf) || tf <= 0) return `posting for ${term} must have positive TF`;
      sums[docId] += tf;
      previous = docId;
    }
  }
  for (let docId = 0; docId < chunkCount; docId++) {
    if (Math.abs(sums[docId] - lexical.documentLengths[docId]) > 1e-3) {
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

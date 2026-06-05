/**
 * Hybrid semantic + lexical search over a prebuilt index.
 * Ranking = Reciprocal Rank Fusion of cosine similarity (meaning) and
 * term-overlap (exact names). The model is read from the index, so callers
 * never have to repeat --model at search time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { embed, cosine, resolveModel } from './core.mjs';

// Common ru/en function words — they match everywhere and pollute lexical scores.
const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'has', 'with', 'this', 'that', 'from',
  'not', 'but', 'you', 'your', 'can', 'all', 'any', 'its',
  'все', 'как', 'что', 'это', 'при', 'для', 'или', 'был', 'без', 'над',
  'под', 'так', 'его', 'нет', 'код', 'кода', 'есть',
]);

function tokenize(text) {
  const m = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu);
  return m ? m.filter(t => !STOP.has(t)) : [];
}

function keywordScores(chunks, query) {
  const qTerms = new Set(tokenize(query));
  return chunks.map(c => {
    const hay = `${c.title} ${c.heading} ${c.text}`.toLowerCase();
    let s = 0;
    for (const t of qTerms) if (hay.includes(t)) s++;
    return s;
  });
}

/** Reciprocal Rank Fusion. rankings: arrays of {idx, score}; higher = better. */
function rrf(rankings, k = 60) {
  const fused = new Map();
  for (const ranking of rankings) {
    const sorted = [...ranking].sort((a, b) => b.score - a.score);
    sorted.forEach((item, rank) => {
      if (item.score <= 0) return;
      fused.set(item.idx, (fused.get(item.idx) || 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

/**
 * @param {object} opts
 * @param {string} opts.indexDir
 * @param {string} opts.cacheDir
 * @param {string} opts.query
 * @param {number} [opts.k=6]
 * @param {boolean} [opts.semanticOnly=false]
 * @returns {Promise<Array>} results with file, title, heading, cosine, score, snippet
 */
export async function search(opts) {
  const { indexDir, cacheDir, query, k = 6, semanticOnly = false } = opts;
  const vectorsPath = path.join(indexDir, 'vectors.json');
  if (!fs.existsSync(vectorsPath)) {
    throw new Error(`No index at ${vectorsPath}. Run \`mdss index\` first.`);
  }
  const index = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  const model = resolveModel(index.modelAlias || index.model);

  const [qVec] = await embed([query], 'query', model, cacheDir);

  const semantic = index.chunks.map((c, idx) => ({ idx, score: cosine(qVec, c.vec) }));
  const cosByIdx = new Map(semantic.map(s => [s.idx, s.score]));

  let ranked;
  if (semanticOnly) {
    ranked = [...semantic].sort((a, b) => b.score - a.score).slice(0, k)
      .map(s => ({ idx: s.idx, fscore: s.score, cos: s.score }));
  } else {
    const kw = keywordScores(index.chunks, query).map((score, idx) => ({ idx, score }));
    const fused = rrf([semantic, kw]);
    ranked = [...fused.entries()]
      .map(([idx, fscore]) => ({ idx, fscore, cos: cosByIdx.get(idx) }))
      .sort((a, b) => b.fscore - a.fscore)
      .slice(0, k);
  }

  return ranked.map(r => {
    const c = index.chunks[r.idx];
    return {
      file: c.file,
      title: c.title,
      heading: c.heading,
      cosine: +r.cos.toFixed(3),
      score: +r.fscore.toFixed(4),
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 220),
    };
  });
}

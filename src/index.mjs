// @ts-check
/**
 * Public library API for md-semantic-search.
 *
 * Import from a consumer project:
 *
 *   import { buildIndex, search, loadIndex, resolveModel, MODELS } from 'md-semantic-search';
 *
 * One-shot usage (parses the index on every call):
 *
 *   await buildIndex({ db: './docs', indexDir: './.mdss', cacheDir: '~/.cache/mdss' });
 *   const hits = await search({ indexDir: './.mdss', cacheDir: '~/.cache/mdss', query: 'rotate api token' });
 *
 * Repeated queries in one process (parse + model cached, issue #2):
 *
 *   const idx = loadIndex('./.mdss');            // parses vectors.json once
 *   const hitsA = await idx.search('failover runbook');
 *   const hitsB = await idx.search('db backup');  // reuses chunks + extractor
 *
 * All functions are model- and path-agnostic: they take explicit paths, so the
 * same API works on any folder of markdown anywhere on disk.
 */

export {
  buildIndex, chunkHash,
} from './indexer.mjs';

export {
  search, searchIndex, loadIndex,
  tokenize, keywordScores, rrf,
} from './search.mjs';

export {
  resolveModel, MODELS, DEFAULT_MODEL,
} from './models.mjs';

export {
  getReranker, rerankScores, RERANK_MODEL,
} from './rerank.mjs';

export {
  embed, getExtractor, cosine,
  walkMarkdown, parseFile, chunkMarkdown,
  splitFrontmatter, extractTitle, globToRegExp,
  encodeVec, decodeVec, isBinaryIndex,
} from './core.mjs';

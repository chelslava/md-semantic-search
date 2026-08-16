/**
 * Public library API for md-semantic-search.
 *
 * Import from a consumer project:
 *
 *   import { buildIndex, search, loadIndex, searchIndex, resolveModel, MODELS } from 'md-semantic-search';
 *
 * One-shot usage (parses the index on every call):
 *
 *   await buildIndex({ db: './docs', indexDir: './.mdss', cacheDir: '~/.cache/mdss' });
 *   const hits = await search({ indexDir: './.mdss', cacheDir: '~/.cache/mdss', query: 'rotate api token' });
 *
 * Repeated queries in one process (parse + model cached, issue #2):
 *
 *   const loaded = loadIndex('./.mdss');
 *   const hitsA = await searchIndex({ loaded, cacheDir: '~/.cache/mdss', query: 'failover runbook' });
 *   const hitsB = await searchIndex({ loaded, cacheDir: '~/.cache/mdss', query: 'db backup' });
 *
 * All functions are model- and path-agnostic: they take explicit paths, so the
 * same API works on any folder of markdown anywhere on disk.
 */

export { buildIndex, chunkHash } from './indexer.js';

export {
  search, searchIndex, loadIndex,
  tokenize, keywordScores, rrf, QueryEmbeddingCache,
} from './search.js';

export {
  resolveModel, MODELS, DEFAULT_MODEL,
  normalizeAdapter, embeddingAdapterFingerprint, legacyEmbeddingAdapterFingerprint,
} from './models.js';

export {
  getReranker, rerankScores, RERANK_MODEL,
} from './rerank.js';

export {
  embed, getExtractor, cosine,
  walkMarkdown, parseFile, chunkMarkdown,
  splitFrontmatter, extractTitle, globToRegExp,
  encodeVec, decodeVec, isBinaryIndex,
} from './core.js';

export {
  MCP_TOOLS, handleMcpRequest, startMcpServer,
} from './mcp.js';

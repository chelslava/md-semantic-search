// @ts-check
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

export {
  buildIndex, chunkHash,
} from './indexer.mjs';

export {
  search, searchIndex, loadIndex,
  tokenize, keywordScores, rrf, QueryEmbeddingCache,
} from './search.mjs';

export {
  resolveModel, MODELS, DEFAULT_MODEL,
  normalizeAdapter, embeddingAdapterFingerprint, legacyEmbeddingAdapterFingerprint,
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

export {
  MCP_TOOLS, handleMcpRequest, startMcpServer,
} from './mcp.mjs';

#!/usr/bin/env node
/**
 * md-semantic-search (mdss) — local semantic search over any folder of .md files.
 *
 *   mdss index  --db <dir> [--model e5-base] [--index-dir <dir>] [--ignore <glob>]
 *   mdss search --db <dir> [--k 6] [--json] [--semantic] "query text"
 *   mdss models
 *
 * The markdown base (--db) can live anywhere on disk — it does NOT need to be
 * inside this project. The index defaults to <db>/.mdss unless --index-dir is given.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildIndex } from '../src/indexer.mjs';
import { search } from '../src/search.mjs';
import { MODELS, DEFAULT_MODEL } from '../src/models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const DEFAULT_CACHE = path.join(PKG_ROOT, '.cache');

function parseArgs(argv) {
  const opts = { _: [], ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--index-dir') opts.indexDir = argv[++i];
    else if (a === '--cache-dir') opts.cacheDir = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--k') opts.k = parseInt(argv[++i], 10);
    else if (a === '--ignore') opts.ignore.push(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--semantic') opts.semantic = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

function resolveDb(opts) {
  const db = opts.db || process.env.MDSS_DB;
  if (!db) die('Missing --db <dir> (or set MDSS_DB). Path to your .md folder.');
  const abs = path.resolve(db);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    die(`--db is not a directory: ${abs}`);
  }
  return abs;
}

function resolveIndexDir(opts, db) {
  // Default: <db>/.mdss. Override with --index-dir or MDSS_INDEX_DIR.
  const dir = opts.indexDir || process.env.MDSS_INDEX_DIR || path.join(db, '.mdss');
  return path.resolve(dir);
}

const resolveCache = (opts) =>
  path.resolve(opts.cacheDir || process.env.MDSS_CACHE_DIR || DEFAULT_CACHE);

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const HELP = `md-semantic-search (mdss) — local, private semantic search over Markdown

Usage:
  mdss index  --db <dir> [options]            Build/refresh the index
  mdss search --db <dir> [options] "query"    Search by meaning
  mdss models                                  List available models

Options:
  --db <dir>          Folder of .md files (or env MDSS_DB). Can be anywhere.
  --index-dir <dir>   Where to store the index (default: <db>/.mdss).
  --cache-dir <dir>   Model cache dir (default: <pkg>/.cache or MDSS_CACHE_DIR).
  --model <name|id>   Embedding model (default: ${DEFAULT_MODEL}). See \`mdss models\`.
  --ignore <glob>     Skip files/paths (repeatable). e.g. --ignore "log.md".
  --k <n>             Number of results (search, default 6).
  --json              Machine-readable output (search).
  --semantic          Pure vector ranking, skip lexical/RRF fusion (search).
  -h, --help          Show this help.

Examples:
  mdss index  --db ./docs
  mdss index  --db /abs/path/to/wiki --model bge-m3 --ignore "log.md" --ignore "**/archive/**"
  mdss search --db ./docs "how do I rotate the api token"
  MDSS_DB=./docs mdss search "rollback a failed migration" --k 8 --json
`;

async function cmdIndex(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const t0 = Date.now();
  const r = await buildIndex({
    db, indexDir, cacheDir,
    modelName: opts.model || DEFAULT_MODEL,
    ignore: opts.ignore,
    log: s => process.stderr.write(s + '\n'),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(
    `\nIndexed ${r.files} file(s) → ${r.chunks} chunks ` +
    `(${r.reused} reused, ${r.embedded} embedded), dim=${r.dim}, ` +
    `model=${r.model}, ${secs}s\n→ ${r.vectorsPath}\n`,
  );
}

async function cmdSearch(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const query = opts._.join(' ').trim();
  if (!query) die('Missing query text. e.g. mdss search --db ./docs "your question"');

  const results = await search({
    indexDir, cacheDir, query,
    k: opts.k || 6,
    semanticOnly: !!opts.semantic,
  });

  if (opts.json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
  if (results.length === 0) { process.stdout.write('No matches.\n'); return; }

  process.stdout.write(`\nTop ${results.length} for: "${query}"\n\n`);
  results.forEach((r, i) => {
    const loc = r.heading ? `${r.file} › ${r.heading}` : r.file;
    process.stdout.write(`${i + 1}. [cos ${r.cosine}] ${r.title}\n`);
    process.stdout.write(`   ${loc}\n`);
    process.stdout.write(`   ${r.snippet}${r.snippet.length >= 220 ? '…' : ''}\n\n`);
  });
}

function cmdModels() {
  process.stdout.write('Available models (alias → id):\n\n');
  for (const [alias, m] of Object.entries(MODELS)) {
    const star = alias === DEFAULT_MODEL ? ' (default)' : '';
    process.stdout.write(`  ${alias}${star}\n    ${m.id} · dim ${m.dim}\n    ${m.note}\n\n`);
  }
  process.stdout.write('You can also pass any raw Xenova/* model id to --model.\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._.shift();

  if (opts.help || !cmd) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'index': return cmdIndex(opts);
    case 'search': return cmdSearch(opts);
    case 'models': return cmdModels();
    default: die(`unknown command: ${cmd}. Try \`mdss --help\`.`);
  }
}

main().catch(e => die(e.message));

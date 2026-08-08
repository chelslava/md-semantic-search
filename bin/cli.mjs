#!/usr/bin/env node
// @ts-check
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { buildIndex } from '../src/indexer.mjs';
import { search } from '../src/search.mjs';
import { createServe, DEFAULT_PORT, DEFAULT_HOST } from '../src/serve.mjs';
import { MODELS, DEFAULT_MODEL } from '../src/models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

/**
 * User-level model cache. Default: ~/.cache/mdss (respecting XDG_CACHE_HOME on
 * POSIX); falls back to <pkg>/.cache when homedir is unavailable. Explicit
 * --cache-dir / MDSS_CACHE_DIR always win (issue #9).
 */
function defaultCacheDir() {
  try {
    if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'mdss');
    const home = os.homedir();
    if (home) return path.join(home, '.cache', 'mdss');
  } catch { /* homedir unavailable */ }
  return path.join(PKG_ROOT, '.cache');
}

function parseArgs(argv) {
  const opts = { _: [], ignore: [], path: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--semantic') opts.semantic = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--rerank') opts.rerank = true;
    else if (a === '--version') opts.version = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--db') opts.db = nextValue(argv, ++i, a);
    else if (a === '--index-dir') opts.indexDir = nextValue(argv, ++i, a);
    else if (a === '--cache-dir') opts.cacheDir = nextValue(argv, ++i, a);
    else if (a === '--model') opts.model = nextValue(argv, ++i, a);
    else if (a === '--k') opts.k = nextInt(argv, ++i, a);
    else if (a === '--port') opts.port = nextInt(argv, ++i, a);
    else if (a === '--host') opts.host = nextValue(argv, ++i, a);
    else if (a === '--since') opts.since = nextValue(argv, ++i, a);
    else if (a === '--path') opts.path.push(nextValue(argv, ++i, a));
    else if (a === '--ignore') opts.ignore.push(nextValue(argv, ++i, a));
    else if (a.startsWith('-')) die(`unknown option: ${a}. Try \`mdss --help\`.`);
    else opts._.push(a);
  }
  return opts;
}

/** Value of the flag at `i`; errors when missing or followed by another flag. */
function nextValue(argv, i, flag) {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) die(`missing value for ${flag}`);
  return v;
}

/** Like nextValue but requires a positive integer (issue #8: --k abc → clear error). */
function nextInt(argv, i, flag) {
  const v = nextValue(argv, i, flag);
  const k = Number.parseInt(v, 10);
  if (!Number.isInteger(k) || k <= 0) die(`${flag} must be a positive integer, got "${v}"`);
  return k;
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
  path.resolve(opts.cacheDir || process.env.MDSS_CACHE_DIR || defaultCacheDir());

/** --offline flag or MDSS_OFFLINE=1 env → never touch the network. */
const resolveOffline = (opts) => !!opts.offline || !!process.env.MDSS_OFFLINE;

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
const HELP = `md-semantic-search (mdss) — local, private semantic search over Markdown

Usage:
  mdss index  --db <dir> [options]            Build/refresh the index
  mdss search --db <dir> [options] "query"    Search by meaning
  mdss serve  --db <dir> [--port <n>] [--host <ip>] [--watch]  Daemon: warm model + index
  mdss models                                  List available models

Options:
  --db <dir>          Folder of .md files (or env MDSS_DB). Can be anywhere.
  --index-dir <dir>   Where to store the index (default: <db>/.mdss).
  --cache-dir <dir>   Model cache dir (default: ~/.cache/mdss, or MDSS_CACHE_DIR).
  --model <name|id>   Embedding model (default: ${DEFAULT_MODEL}). See \`mdss models\`.
  --ignore <glob>     Skip files/paths (repeatable). e.g. --ignore "log.md".
  --path <glob>       Search only files matching glob (repeatable). e.g. --path "docs/**".
  --since <date>      Search only files modified at/after date (YYYY-MM-DD or ISO).
  --k <n>             Number of results (search, default 6).
  --json              Machine-readable output (search).
  --semantic          Pure vector ranking, skip lexical/RRF fusion (search).
  --rerank            Re-rank candidates with a cross-encoder (search; ~280MB model).
  --port <n>          HTTP port for serve (default: ${DEFAULT_PORT}).
  --host <ip>         Bind address for serve (default: ${DEFAULT_HOST} — loopback
                      only; use 0.0.0.0 to expose on the LAN, env MDSS_HOST).
  --watch             serve: re-index incrementally on file changes (mtime poll).
  --offline           Never download the model; require a cached one (env MDSS_OFFLINE=1).
  --version           Print the version and exit.
  -h, --help          Show this help.

Examples:
  mdss index  --db ./docs
  mdss index  --db /abs/path/to/wiki --model bge-m3 --ignore "log.md" --ignore "**/archive/**"
  mdss search --db ./docs "how do I rotate the api token"
  MDSS_DB=./docs mdss search "rollback a failed migration" --k 8 --json
  mdss search --db ./docs "incident runbook" --path "docs/**" --since 2026-01-01
  mdss serve  --db ./docs --port 8747 --watch
  curl -X POST localhost:8747/search -d '{"query":"rotate api token","k":5}'
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
    offline: resolveOffline(opts),
    log: s => process.stderr.write(s + '\n'),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const skipped = r.skipped > 0 ? `, ${r.skipped} skipped` : '';
  process.stderr.write(
    `\nIndexed ${r.files} file(s) → ${r.chunks} chunks ` +
    `(${r.reused} reused [${r.reusedChunks} chunk-level, ${r.reusedFiles} file-level], ` +
    `${r.embedded} embedded)${skipped}, dim=${r.dim}, ` +
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
    offline: resolveOffline(opts),
    path: opts.path.length > 0 ? opts.path : undefined,
    since: opts.since,
    rerank: !!opts.rerank,
  });

  if (opts.json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
  if (results.length === 0) { process.stdout.write('No matches.\n'); return; }

  process.stdout.write(`\nTop ${results.length} for: "${query}"\n\n`);

  // Group by file (issue #13): each file becomes a header with its hits below.
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  const color = !!process.stdout.isTTY; // bold matched terms only on a real terminal
  let rank = 0;
  for (const [file, hits] of byFile) {
    process.stdout.write(`${file}\n`);
    for (const r of hits) {
      rank++;
      let snippet = r.snippet;
      if (color && r.matches && r.matches.length > 0) {
        const re = new RegExp(`(${r.matches.map(escRe).join('|')})`, 'gi');
        snippet = snippet.replace(re, '\x1b[1m$1\x1b[0m');
      }
      const loc = r.heading ? `   ${r.heading}\n` : '';
      process.stdout.write(`  ${rank}. [cos ${r.cosine}] ${r.title}\n`);
      if (loc) process.stdout.write(loc);
      process.stdout.write(`   ${snippet}${r.snippet.length >= 220 ? '…' : ''}\n\n`);
    }
  }
}

/** Escape a string for use inside a RegExp. */
function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cmdModels() {
  process.stdout.write('Available models (alias → id):\n\n');
  for (const [alias, m] of Object.entries(MODELS)) {
    const star = alias === DEFAULT_MODEL ? ' (default)' : '';
    process.stdout.write(`  ${alias}${star}\n    ${m.id} · dim ${m.dim}\n    ${m.note}\n\n`);
  }
  process.stdout.write('You can also pass any raw Xenova/* model id to --model.\n');
}

async function cmdServe(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const port = opts.port || Number(process.env.MDSS_PORT) || DEFAULT_PORT;
  // Loopback by default — LAN exposure is opt-in via --host (issue #16).
  const host = opts.host || process.env.MDSS_HOST || DEFAULT_HOST;
  const log = s => process.stderr.write(s + '\n');

  const { server, state, close } = await createServe({
    db, indexDir, cacheDir,
    modelName: opts.model || DEFAULT_MODEL,
    ignore: opts.ignore,
    offline: resolveOffline(opts),
    watch: !!opts.watch,
    log,
  });

  server.listen(port, host, () => {
    const idx = state.loaded.index;
    log(`mdss serve listening on http://${host}:${port}` +
      (host === '127.0.0.1' || host === '::1' ? ' (loopback only)' : ''));
    log(`  index: ${idx.chunks.length} chunks · model ${state.loaded.model.id}` +
      (state.watching ? ' · watching for changes' : ''));
    log(`  POST /search  {"query": "...", "k": 6}`);
    log(`  GET  /health`);
    log(`  Ctrl+C to stop.`);
  });

  const stop = async (sig) => {
    log(`\n${sig} — shutting down.`);
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._.shift();

  if (opts.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (opts.help || !cmd) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'index': return cmdIndex(opts);
    case 'search': return cmdSearch(opts);
    case 'serve': return cmdServe(opts);
    case 'models': return cmdModels();
    default: die(`unknown command: ${cmd}. Try \`mdss --help\`.`);
  }
}

// Run only when executed directly (`node bin/cli.mjs`, `mdss`), never when
// imported by tests or library consumers (issue #29).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => die(e.message));
}

// Exported for the CLI harness tests (issue #29): the pure argument/resolution
// functions are unit-tested directly; die() is asserted via a mocked
// process.exit so a bad flag cannot kill the test runner.
export {
  parseArgs, nextInt, nextValue,
  resolveDb, resolveIndexDir, resolveCache, resolveOffline,
  die, main, HELP, VERSION,
};

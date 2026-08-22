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
import crypto from 'node:crypto';
import { buildIndex } from '../dist/indexer.js';
import { search } from '../dist/search.js';
import { searchFederated } from '../dist/federation.js';
import { createServe, DEFAULT_PORT, DEFAULT_HOST } from '../dist/serve.js';
import { MODELS, DEFAULT_MODEL, resolveModel } from '../dist/models.js';
import { decodeVec, walkMarkdown, SCHEMA_VERSION, assertSafePath } from '../dist/core.js';
import { inspectIndexSchema, validateCurrentChunk, validateIndexEnvelope, validateNumericVector } from '../dist/index-format.js';

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
  const opts = { _: [], ignore: [], path: [], vaults: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--semantic') opts.semantic = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--rerank') opts.rerank = true;
    else if (a === '--explain') opts.explain = true;
    else if (a === '--interactive' || a === '-i') opts.interactive = true;
    else if (a === '--list-tools') opts.listTools = true;
    else if (a === '--version') opts.version = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--workers') opts.workers = nextInt(argv, ++i, a);
    else if (a === '--config') opts.config = nextValue(argv, ++i, a);
    else if (a === '--format') opts.format = nextValue(argv, ++i, a);
    else if (a === '--no-vectors' || a === '--no-vector') opts.noVectors = true;
    else if (a === '--output' || a === '-o') opts.output = nextValue(argv, ++i, a);
    else if (a === '--db') opts.db = nextValue(argv, ++i, a);
    else if (a === '--vault') opts.vaults.push(nextValue(argv, ++i, a));
    else if (a === '--index-dir') opts.indexDir = nextValue(argv, ++i, a);
    else if (a === '--cache-dir') opts.cacheDir = nextValue(argv, ++i, a);
    else if (a === '--model') opts.model = nextValue(argv, ++i, a);
    else if (a === '--k') opts.k = nextInt(argv, ++i, a);
    else if (a === '--max-per-file') opts.maxPerFile = nextInt(argv, ++i, a);
    else if (a === '--max-per-doc') opts.maxPerDoc = nextInt(argv, ++i, a);
    else if (a === '--target-tokens') opts.targetTokens = nextInt(argv, ++i, a);
    else if (a === '--port') opts.port = nextInt(argv, ++i, a);
    else if (a === '--host') opts.host = nextValue(argv, ++i, a);
    else if (a === '--api-key') opts.apiKey = nextValue(argv, ++i, a);
    else if (a === '--health-public') opts.healthPublic = true;
    else if (a === '--watch-delay') opts.watchDelay = nextInt(argv, ++i, a);
    else if (a === '--watch-interval') opts.watchInterval = nextInt(argv, ++i, a);
    else if (a === '--since') opts.since = nextValue(argv, ++i, a);
    else if (a === '--path') opts.path.push(nextValue(argv, ++i, a));
    else if (a === '--ignore') opts.ignore.push(nextValue(argv, ++i, a));
    else if (a === '--tag') {
      const v = nextValue(argv, ++i, a);
      opts.tag = opts.tag ? (Array.isArray(opts.tag) ? [...opts.tag, v] : [opts.tag, v]) : v;
    }
    else if (a === '--ann') opts.ann = true;
    else if (a === '--nprobe') opts.nprobe = nextInt(argv, ++i, a);
    else if (a === '--project') opts.project = nextValue(argv, ++i, a);
    else if (a === '--type') opts.type = nextValue(argv, ++i, a);
    else if (a === '--status') opts.status = nextValue(argv, ++i, a);
    else if (a === '--canonical') opts.canonical = true;
    else if (a === '--graph-boost') opts.graphBoost = nextFloat(argv, ++i, a);
    else if (a === '--filter') opts.filter = nextValue(argv, ++i, a);
    else if (a === '--quantize') opts.quantize = nextValue(argv, ++i, a);
    else if (a === '--rag') opts.rag = true;
    else if (a === '--auto-tag') opts.autoTag = true;
    else if (a === '--auto-summarize') opts.autoSummarize = true;
    else if (a === '--llm-endpoint') opts.llmEndpoint = nextValue(argv, ++i, a);
    else if (a === '--llm-model') opts.llmModel = nextValue(argv, ++i, a);
    else if (a === '--system-prompt') opts.systemPrompt = nextValue(argv, ++i, a);
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

/** Like nextValue but requires a non-negative float. */
function nextFloat(argv, i, flag) {
  const v = nextValue(argv, i, flag);
  const f = Number.parseFloat(v);
  if (!Number.isFinite(f) || f < 0) die(`${flag} must be a non-negative number, got "${v}"`);
  return f;
}

const KNOWN_CONFIG_KEYS = new Set([
  'db', 'model', 'indexDir', 'index-dir', 'cacheDir', 'cache-dir',
  'ignore', 'path', 'k', 'maxPerFile', 'max-per-file', 'maxPerDoc', 'max-per-doc',
  'targetTokens', 'target-tokens', 'port', 'host', 'apiKey', 'api-key',
  'healthPublic', 'health-public', 'watch', 'watchInterval', 'watch-interval',
  'watchDelay', 'watch-delay', 'offline', 'rerank', 'semantic', 'tag', 'project', 'type', 'status', 'canonical',
  'format', 'noVectors', 'no-vectors', 'output', 'workers', 'ann', 'nprobe', 'graphBoost', 'graph-boost', 'filter', 'quantize',
  'vault', 'vaults', 'rag', 'autoTag', 'auto-tag', 'autoSummarize', 'auto-summarize',
  'llmEndpoint', 'llm-endpoint', 'llmModel', 'llm-model', 'systemPrompt', 'system-prompt'
]);

function findConfigFile(explicitPath) {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) die(`config file not found: ${abs}`);
    return abs;
  }
  if (process.env.MDSS_CONFIG) {
    const abs = path.resolve(process.env.MDSS_CONFIG);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) die(`config file from MDSS_CONFIG not found: ${abs}`);
    return abs;
  }
  const configNames = ['.mdssrc.json', 'mdss.config.json', '.mdssrc'];
  let curr = process.cwd();
  while (true) {
    for (const name of configNames) {
      const candidate = path.join(curr, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  try {
    const home = os.homedir();
    if (home) {
      for (const name of ['.mdssrc.json', '.mdssrc']) {
        const candidate = path.join(home, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
    }
  } catch {}
  return null;
}

function loadConfigFile(configPath) {
  if (!configPath) return { config: {}, path: null, unknownKeys: [], error: null };
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, path: configPath, unknownKeys: [], error: `Config at ${configPath} must be a JSON object` };
    }
    const unknownKeys = Object.keys(parsed).filter(k => !KNOWN_CONFIG_KEYS.has(k));
    const normalized = {};
    for (const [k, v] of Object.entries(parsed)) {
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      normalized[camel] = v;
    }
    return { config: normalized, path: configPath, unknownKeys, error: null };
  } catch (e) {
    return { config: {}, path: configPath, unknownKeys: [], error: `Failed to parse config at ${configPath}: ${e.message}` };
  }
}

function applyConfigDefaults(opts, config) {
  for (const [k, v] of Object.entries(config)) {
    if (k === 'ignore' || k === 'path') {
      if ((!opts[k] || opts[k].length === 0) && v !== undefined) {
        opts[k] = Array.isArray(v) ? [...v] : [v];
      }
    } else if (opts[k] === undefined && v !== undefined) {
      opts[k] = v;
    }
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
  let safeDb;
  try {
    safeDb = assertSafePath(abs);
  } catch (e) {
    die(e.message);
  }
  return safeDb;
}

function resolveIndexDir(opts, db) {
  // Default: <db>/.mdss. Override with --index-dir or MDSS_INDEX_DIR.
  const dir = opts.indexDir || process.env.MDSS_INDEX_DIR || path.join(db, '.mdss');
  try {
    return assertSafePath(dir);
  } catch (e) {
    die(e.message);
  }
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
  mdss stats  --db <dir> [--json]             Index stats without loading the model
  mdss check  --db <dir> [--json]             Diagnose index/db/model cache (alias: doctor)
  mdss export --db <dir> [options]            Export index to JSONL / CSV / Parquet
  mdss search --db <dir> [options] "query"    Search by meaning
  mdss serve  --db <dir> [--port <n>] [--host <ip>] [--watch]  Daemon: warm model + index
  mdss mcp    --db <dir> [--list-tools]       Start MCP server over stdio for LLM agents / IDEs
  mdss models                                  List available models

Options:
  --config <file>     Path to config file (default: .mdssrc.json / mdss.config.json).
  --db <dir>          Folder of .md files (or env MDSS_DB). Can be anywhere.
  --index-dir <dir>   Where to store the index (default: <db>/.mdss).
  --cache-dir <dir>   Model cache dir (default: ~/.cache/mdss, or MDSS_CACHE_DIR).
  --model <name|id>   Embedding model (default: ${DEFAULT_MODEL}). See \`mdss models\`.
  --workers <n>       Number of parallel batch workers for indexing (default: 1).
  --format <fmt>      Export format: jsonl (default), csv, parquet (export).
  --no-vectors        Omit vector embeddings from export (export).
  --output <file>     Output file path (export, default: stdout).
  --ignore <glob>     Skip files/paths (repeatable). e.g. --ignore "log.md".
  --path <glob>       Search only files matching glob (repeatable). e.g. --path "docs/**".
  --since <date>      Search only files modified at/after date (YYYY-MM-DD or ISO).
  --k <n>             Number of results (search, default 6).
  --json              Machine-readable output (index, stats, search).
  --semantic          Pure vector ranking, skip lexical/RRF fusion (search).
  --rerank            Re-rank candidates with a cross-encoder (search; ~280MB model).
  --graph-boost <n>   Boost weight for graph PageRank / Obsidian wikilinks (search, default: 0).
  --filter <expr>     Rich boolean filter across frontmatter tags and properties (search).
  --ann               Approximate nearest neighbor search via IVF (search).
  --nprobe <n>        Number of centroids to probe for ANN (search, default: 8).
  --port <n>          HTTP port for serve (default: ${DEFAULT_PORT}).
  --host <ip>         Bind address for serve (default: ${DEFAULT_HOST} — loopback
                      only; use 0.0.0.0 to expose on the LAN, env MDSS_HOST).
  --watch             serve: re-index incrementally on file changes (mtime poll).
  --watch-interval <ms>  serve --watch: poll every N ms (default 3000).
  --watch-delay <ms>     serve --watch: quiet-period debounce before a burst of
                         saves triggers ONE re-index (default 1000; issue #42).
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

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const remainingS = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(remainingS).padStart(2, '0')}`;
}

async function cmdIndex(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const t0 = Date.now();
  let lastProgressUpdate = 0;

  const onProgress = (done, total, chunksPerSec) => {
    if (!process.stderr.isTTY || opts.json || total <= 100) return;
    const now = Date.now();
    if (now - lastProgressUpdate < 500 && done < total) return;
    lastProgressUpdate = now;
    const percent = Math.floor((done / total) * 100);
    const barWidth = 10;
    const filled = Math.min(barWidth, Math.max(0, Math.round((done / total) * barWidth)));
    const bar = '[' + '#'.repeat(filled) + '-'.repeat(barWidth - filled) + ']';
    const remaining = total - done;
    const etaSec = chunksPerSec > 0 ? remaining / chunksPerSec : 0;
    const etaStr = formatDuration(etaSec);
    const speedStr = `${chunksPerSec.toFixed(1)} chunks/s`;
    const line = `${bar} ${percent}% │ ${done}/${total} chunks │ ${speedStr} │ ETA ${etaStr}`;
    process.stderr.write(`\r${line}`);
    if (done >= total) {
      process.stderr.write('\n');
    }
  };

  let r;
  try {
    r = await buildIndex({
      db, indexDir, cacheDir,
      modelName: opts.model || DEFAULT_MODEL,
      ignore: opts.ignore,
      offline: resolveOffline(opts),
      workers: opts.workers,
      ann: opts.ann,
      quantize: opts.quantize,
      log: s => {
        if (process.stderr.isTTY && !opts.json && /^\s+\d+\/\d+$/.test(s)) return;
        process.stderr.write(s + '\n');
      },
      onProgress,
    });
  } catch (e) {
    // A held index lock (issue #37) is an EXPECTED operational state (a second
    // terminal also indexing, or a `serve --watch` daemon mid-cycle) — surface
    // it as a clean one-line error + hint, not a stack of "locked by pid".
    if (/(being written by pid|index is being written)/i.test(String(e?.message || ''))) {
      die(`${e.message}\nAnother mdss process is writing to this index. ` +
        'Retry once it finishes, or remove a stale .mdss.lock if the holder crashed.');
    }
    throw e;
  }
  // Machine-readable build result for scripts/CI (issue #21): the exact
  // buildIndex return value — lets automation assert "0 embedded" (fully
  // incremental) or "N skipped" without parsing prose.
  if (opts.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const skipped = r.skipped > 0 ? `, ${r.skipped} skipped` : '';
  process.stderr.write(
    `\nIndexed ${r.files} file(s) → ${r.chunks} chunks ` +
    `(${r.reused} reused [${r.reusedChunks} chunk-level, ${r.reusedFiles} file-level], ` +
    `${r.embedded} embedded)${skipped}, dim=${r.dim}, ` +
    `model=${r.model}, ${secs}s\n→ ${r.vectorsPath}\n`,
  );
}

/**
 * `mdss stats` — machine-readable index statistics WITHOUT loading the
 * embedding model: parses only vectors.json + .hashes.json (issue #21).
 * Gives scripts/CI a cheap sanity check after a re-index (counts, model, dim),
 * staleness detection (ageSeconds), and index-path/format info for migrations.
 */
function cmdStats(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const vectorsPath = path.join(indexDir, 'vectors.json');
  const hashesPath = path.join(indexDir, '.hashes.json');
  if (!fs.existsSync(vectorsPath)) {
    die(`No index at ${vectorsPath}. Run \`mdss index\` first.`);
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  } catch (e) {
    die(`${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild.`);
  }
  try {
    validateIndexEnvelope(index, vectorsPath, { encoding: 'stored' });
  } catch (error) {
    die(error.message);
  }

  // File count = keys of .hashes.json (per-file md5 map written by buildIndex).
  // Fall back to unique chunk file paths when the hashes file is missing (a
  // legacy/corrupt index) rather than dying.
  let files;
  try {
    const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
    files = Object.keys(hashes).length;
  } catch {
    files = new Set((index.chunks || []).map(c => c.file)).size;
  }

  const chunks = index.chunkCount ?? (index.chunks ? index.chunks.length : 0);
  const builtMs = index.built ? Date.parse(index.built) : NaN;
  const adapterRepr = (index.model || index.modelAlias)
    ? resolveModel(index.model || index.modelAlias) : null;
  const stats = {
    indexDir,
    schemaVersion: index.schemaVersion ?? 0,
    format: index.format || 'legacy',         // binary-v1 vs pre-0.4 decimal
    lexicalFormat: index.schemaVersion >= 3 ? (index.lexical?.format || 'invalid') : null,
    lexicalStatus: index.schemaVersion >= 3 ? 'persisted-bm25' : 'legacy-overlap',
    model: index.model || null,               // id@revision (issue #27)
    modelAlias: index.modelAlias || null,
    dim: index.dim ?? null,
    pooling: adapterRepr?.pooling ?? 'mean',
    normalize: adapterRepr?.normalize !== false,
    adapterFamily: adapterRepr?.family ?? null,
    adapterFingerprint: index.adapterFingerprint || null,
    chunks,
    files,
    indexBytes: fs.statSync(vectorsPath).size,
    built: index.built || null,
    ageSeconds: Number.isFinite(builtMs) ? Math.floor((Date.now() - builtMs) / 1000) : null,
    db: index.db || db,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return;
  }
  const age = stats.ageSeconds === null ? '?' :
    stats.ageSeconds < 60 ? `${stats.ageSeconds}s` :
    stats.ageSeconds < 3600 ? `${Math.floor(stats.ageSeconds / 60)}m ${stats.ageSeconds % 60}s` :
    stats.ageSeconds < 86400 ? `${Math.floor(stats.ageSeconds / 3600)}h ${Math.floor((stats.ageSeconds % 3600) / 60)}m` :
    `${Math.floor(stats.ageSeconds / 86400)}d`;
  process.stdout.write(
    `Index at ${indexDir}\n` +
    `  format: ${stats.format} · model: ${stats.modelAlias || stats.model || '?'} (dim ${stats.dim ?? '?'})\n` +
    `  adapter: ${stats.pooling}${stats.normalize ? '' : ' · raw'}${stats.adapterFamily ? ' · ' + stats.adapterFamily : ''}\n` +
    `  schema: v${stats.schemaVersion} · lexical: ${stats.lexicalFormat || stats.lexicalStatus}\n` +
    `  chunks: ${chunks} · files: ${files}\n` +
    `  size: ${(stats.indexBytes / 1024).toFixed(1)} KiB (vectors.json)\n` +
    `  built: ${stats.built || '?'} (${age} ago)\n` +
    `  db: ${stats.db}\n`,
  );
}

/**
 * `mdss export` — export the index as JSONL / CSV / Parquet for downstream pipelines (issue #77).
 */
async function cmdExport(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const vectorsPath = path.join(indexDir, 'vectors.json');
  if (!fs.existsSync(vectorsPath)) {
    die(`No index at ${vectorsPath}. Run \`mdss index\` first.`);
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  } catch (e) {
    die(`${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild.`);
  }

  const format = (opts.format || 'jsonl').toLowerCase();
  const noVectors = !!opts.noVectors;
  const outStream = opts.output ? fs.createWriteStream(path.resolve(opts.output), 'utf8') : process.stdout;

  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  const dim = index.dim;

  if (format === 'jsonl') {
    for (const c of chunks) {
      let vec = undefined;
      if (!noVectors && c.vec !== undefined) {
        if (typeof c.vec === 'string') {
          try {
            vec = Array.from(decodeVec(c.vec, dim));
          } catch {
            vec = null;
          }
        } else if (Array.isArray(c.vec) || ArrayBuffer.isView(c.vec)) {
          vec = Array.from(c.vec);
        }
      }
      const record = {
        file: c.file,
        title: c.title,
        heading: c.heading,
        headingPath: c.headingPath,
        text: c.text,
        ...(noVectors ? {} : { vec }),
        ...(c.chunkHash ? { chunkHash: c.chunkHash } : {}),
        ...(c.startLine !== undefined ? { startLine: c.startLine } : {}),
        ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
        ...(c.meta ? { meta: c.meta } : {}),
      };
      outStream.write(JSON.stringify(record) + '\n');
    }
    if (opts.output) {
      await new Promise((resolve) => outStream.end(resolve));
    }
  } else if (format === 'csv') {
    const escapeCsv = (val) => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    outStream.write('file,title,heading,headingPath,text\n');
    for (const c of chunks) {
      const pathStr = Array.isArray(c.headingPath) ? c.headingPath.join(' > ') : (c.heading || '');
      const row = [
        escapeCsv(c.file),
        escapeCsv(c.title),
        escapeCsv(c.heading),
        escapeCsv(pathStr),
        escapeCsv(c.text),
      ].join(',');
      outStream.write(row + '\n');
    }
    if (opts.output) {
      await new Promise((resolve) => outStream.end(resolve));
    }
  } else if (format === 'parquet') {
    let parquet;
    try {
      // @ts-ignore
      parquet = await import('parquetjs-lite');
    } catch {
      die('Parquet export requires optional dependency "parquetjs-lite". Install with: npm install parquetjs-lite');
    }
    if (!opts.output) {
      die('Parquet export requires an output file via --output <file.parquet>');
    }
    const schemaFields = {
      file: { type: 'UTF8' },
      title: { type: 'UTF8' },
      heading: { type: 'UTF8' },
      text: { type: 'UTF8' },
    };
    const schema = new parquet.ParquetSchema(schemaFields);
    const outFile = path.resolve(opts.output);
    const writer = await parquet.ParquetWriter.openFile(schema, outFile);
    for (const c of chunks) {
      await writer.appendRow({
        file: c.file || '',
        title: c.title || '',
        heading: c.heading || '',
        text: c.text || '',
      });
    }
    await writer.close();
  } else {
    die(`unknown export format: "${format}". Supported formats: jsonl, csv, parquet.`);
  }
}

/**
 * Offline diagnostics for the index/db/model-cache trio (issue #43) — the
 * `mdss check` / `mdss doctor` backend. Pure read-only: parses vectors.json +
 * .hashes.json, validates every stored vector with decodeVec (the same
 * validator the loader uses), walks the db for staleness, and checks the
 * transformers.js cache layout for the index's model. NEVER loads the
 * embedding model and NEVER touches the network.
 * @param {{db:string, indexDir:string, cacheDir:string, requireOffline?:boolean, config?:any}} paths
 * @returns {CheckReport}
 */

/**
 * Structured result of checkHealth. Every sub-check is a small object with an
 * `error` (string|null) plus check-specific fields; `healthy` is the AND of
 * all checks (a warning — e.g. missing model cache when NOT offline — does not
 * flip it).
 * @typedef {object} CheckReport
 * @property {boolean} healthy
 * @property {{exists:boolean, parses:boolean, schemaVersion:(number|null), format:(string|null), recognized:boolean, error:(string|null)}} index
 * @property {{exists:boolean, parses:boolean, files:number, error:(string|null)}} hashes
 * @property {{total:number, valid:number, invalid:Array<{where:string, error:string}>}} chunks
 * @property {{exists:boolean, stale:boolean, error:(string|null)}} db
 * @property {{id:(string|null), cached:boolean, cachePath:(string|null), error:(string|null)}} model
 */
function checkHealth({ db, indexDir, cacheDir, requireOffline = false, config = null }) {
  const report = {
    healthy: true,
    index: { exists: false, parses: false, schemaVersion: null, format: null, recognized: true, error: null },
    hashes: { exists: false, parses: false, files: 0, error: null },
    chunks: { total: 0, valid: 0, invalid: [] },
    db: { exists: true, stale: false, error: null },
    model: { id: null, cached: false, cachePath: null, error: null },
    config: null,
  };

  // --- config file: exists, valid JSON, schema / unknown keys (issue #68) ---
  if (config && config.path) {
    report.config = {
      path: config.path,
      valid: !config.error && (!config.unknownKeys || config.unknownKeys.length === 0),
      unknownKeys: config.unknownKeys || [],
      error: config.error || (config.unknownKeys && config.unknownKeys.length > 0 ? `unknown config keys: ${config.unknownKeys.join(', ')}` : null),
    };
    if (!report.config.valid) {
      report.healthy = false;
    }
  }
  const vectorsPath = path.join(indexDir, 'vectors.json');
  const hashesPath = path.join(indexDir, '.hashes.json');

  // --- vectors.json: exists, parses, schema + format recognized (#39) ---
  if (!fs.existsSync(vectorsPath)) {
    report.index.error = `No index at ${vectorsPath}. Run \`mdss index\` first.`;
    report.healthy = false;
    return report; // nothing further is checkable without an index
  }
  report.index.exists = true;
  let index;
  const raw = fs.readFileSync(vectorsPath, 'utf8');
  const shaPath = path.join(indexDir, 'vectors.json.sha256');
  if (fs.existsSync(shaPath)) {
    try {
      const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
      const expectedHash = shaContent.split(/\s+/)[0];
      const actualHash = crypto.createHash('sha256').update(raw).digest('hex');
      if (expectedHash && actualHash !== expectedHash) {
        report.index.error = `vectors.json integrity check failed (SHA-256 mismatch) — run \`mdss index\` to rebuild`;
        report.healthy = false;
        return report;
      }
    } catch { /* ignore unreadable sha file */ }
  }
  try {
    index = JSON.parse(raw);
    report.index.parses = true;
  } catch (e) {
    report.index.error = `${vectorsPath} is not valid JSON (${e.message}); run \`mdss index\` to rebuild`;
    report.healthy = false;
    return report;
  }
  let schemaVersion;
  try {
    ({ schema: schemaVersion } = inspectIndexSchema(index, 'vectors.json'));
  } catch (error) {
    report.index.recognized = false;
    report.index.error = error.message;
    report.healthy = false;
    return report;
  }
  report.index.schemaVersion = schemaVersion;
  report.index.format = index.format || 'legacy';
  report.index.recognized = schemaVersion <= SCHEMA_VERSION;
  let validated;
  try {
    validated = validateIndexEnvelope(index, 'vectors.json', {
      encoding: 'stored', validateVectors: false,
    });
  } catch (error) {
    report.index.error = error.message;
    report.healthy = false;
    return report;
  }

  // --- .hashes.json: parses; file count vs chunk count ---
  if (fs.existsSync(hashesPath)) {
    report.hashes.exists = true;
    try {
      const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
      report.hashes.parses = true;
      report.hashes.files = Object.keys(hashes).length;
    } catch (e) {
      report.hashes.error = `${hashesPath} is not valid JSON (${e.message})`;
      report.healthy = false;
    }
  }

  // --- every chunk's vector: length == dim, no NaN/Infinity, not truncated ---
  // Reuses decodeVec — the exact validator the loader runs (issue #40) — so
  // `mdss check` reports the same "corrupt vector" verdicts without loading
  // the 280MB model.
  const chunks = index.chunks;
  const expectedDim = validated.dim;
  const dim = expectedDim ?? null;
  report.chunks.total = chunks.length;
  for (let position = 0; position < chunks.length; position++) {
    const c = chunks[position];
    const where = c && typeof c === 'object' && !Array.isArray(c)
      ? `${c.file}${c.heading ? ` › ${c.heading}` : ''}` : `chunk ${position}`;
    let bad = null;
    try {
      if (schemaVersion >= 3) {
        validateCurrentChunk(c, position, {
          dim: dim ?? undefined, encoding: 'stored', allowMissingVector: undefined,
        });
      } else if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        throw new Error(`chunk ${position} must be an object — run \`mdss index\` to rebuild`);
      } else if (typeof c.vec === 'string') {
        decodeVec(c.vec, dim ?? undefined);
      } else {
        validateNumericVector(c.vec, dim ?? undefined, `chunk ${where}`);
      }
    } catch (error) {
      bad = error.message;
    }
    if (bad) {
      report.healthy = false;
      report.chunks.invalid.push({ where, error: bad });
    } else {
      report.chunks.valid++;
    }
  }

  // --- db dir: exists; newest file mtime vs built (stale?) — same 5s grace ---
  // as warnIfStale, so a same-second touch doesn't count as a problem.
  if (!fs.existsSync(db) || !fs.statSync(db).isDirectory()) {
    report.db.exists = false;
    report.db.error = `db dir missing: ${db}`;
    report.healthy = false;
  } else {
    let newest = 0;
    try {
      for (const f of walkMarkdown(db)) {
        const st = fs.statSync(f);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch { /* unreadable db → newest stays 0, staleness check is moot */ }
    const builtMs = index.built ? Date.parse(index.built) : NaN;
    if (Number.isFinite(builtMs) && newest > builtMs + 5000) {
      report.db.stale = true;
      report.healthy = false;
    }
  }

  // --- model cache: transformers.js FileCache keys under cacheDir ---
  // Offline readiness — the model must be downloaded before search works in
  // --offline mode. Missing cache is a warning unless the user explicitly
  // demands offline readiness (then it's a failure, issue #43).
const modelId = index.model ?? null;
  report.model.id = modelId;
  if (modelId) {
    const model = resolveModel(modelId);
    report.model.pooling = model.pooling ?? 'mean';
    report.model.normalize = model.normalize !== false;
    report.model.adapterFamily = model.family ?? null;
    report.model.dim = model.dim ?? null;
    const cachePath = path.join(cacheDir, model.id,
      ...((model.revision ?? 'main') === 'main' ? [] : [model.revision]));
    report.model.cachePath = cachePath;
    report.model.cached = fs.existsSync(cachePath);
    if (!report.model.cached) {
      report.model.error =
        `model cache for ${modelId} not found at ${cachePath} — offline search will fail ` +
        '(the first online run downloads it)';
      if (requireOffline) report.healthy = false;
    }
  }
  return report;
}

/**
 * `mdss check` (alias: `mdss doctor`) — offline diagnostics (issue #43).
 * Reports what is broken about the index/db/model-cache without loading the
 * embedding model or touching the network. Exit code 0 when healthy, 1 with a
 * summary when not; `--json` for scripting.
 */
function cmdCheck(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const report = checkHealth({
    db, indexDir, cacheDir,
    requireOffline: resolveOffline(opts),
    config: opts._config,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  const ok = (s) => `  ok    ${s}\n`;
  const warn = (s) => `  warn  ${s}\n`;
  const fail = (s) => `  FAIL  ${s}\n`;
  let out = `check: ${indexDir}\n`;

  // If there is no index or it doesn't parse, the report contains only the
  // index error — chunks/db/model are NOT checkable, show just that.
  if (!report.index.exists || !report.index.parses) {
    out += fail(report.index.error);
    out += 'check: 1+ problem(s) found (exit 1)\n';
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }
  out += ok(`vectors.json: parses (schema v${report.index.schemaVersion}, ` +
    `${report.index.format})`);
  if (report.index.error) {
    out += fail(report.index.error);
    out += 'check: 1+ problem(s) found (exit 1)\n';
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }

  if (report.hashes.exists && report.hashes.parses) {
    out += ok(`.hashes.json: parses (${report.hashes.files} file(s))`);
  } else if (report.hashes.exists) {
    out += fail(report.hashes.error);
  } else {
    out += warn('.hashes.json: missing (file count unknown)');
  }

  if (report.chunks.invalid.length === 0) {
    out += ok(`chunks: ${report.chunks.valid}/${report.chunks.total} vectors valid (dim from index)`);
  } else {
    out += fail(`chunks: ${report.chunks.valid}/${report.chunks.total} vectors valid, ` +
      `${report.chunks.invalid.length} invalid`);
    for (const bad of report.chunks.invalid.slice(0, 5)) {
      out += `       ${bad.where}: ${bad.error}\n`;
    }
    if (report.chunks.invalid.length > 5) {
      out += `       …and ${report.chunks.invalid.length - 5} more\n`;
    }
  }

  if (report.db.error) {
    out += fail(report.db.error);
  } else if (report.db.stale) {
    out += fail(`db ${db}: STALE — files changed after the index was built; ` +
      'run `mdss index` to refresh');
  } else {
    out += ok(`db ${db}: fresh`);
  }

  if (report.model.id) {
    if (report.model.cached) {
      out += ok(`model cache: ${report.model.id} present at ${report.model.cachePath}`);
    } else if (resolveOffline(opts)) {
      out += fail(report.model.error); // required offline → missing cache is a failure
    } else {
      out += warn(report.model.error);
    }
  } else {
    out += warn('model: index has no model field (legacy index)');
  }

  if (report.config) {
    if (report.config.valid) {
      out += ok(`config: ${report.config.path}`);
    } else {
      out += fail(`config: ${report.config.path} (${report.config.error})`);
    }
  }

  out += report.healthy
    ? 'check: healthy (exit 0)\n'
    : 'check: 1+ problem(s) found (exit 1)\n';
  process.stdout.write(out);
  process.exitCode = report.healthy ? 0 : 1;
}

async function cmdTui(opts) {
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const query = opts._.join(' ').trim();
  const { runTui } = await import('../dist/tui.js');
  await runTui({
    db, indexDir, cacheDir, query,
    k: opts.k || 20,
    semanticOnly: !!opts.semantic,
    offline: resolveOffline(opts),
    path: opts.path.length > 0 ? opts.path : undefined,
    rerank: !!opts.rerank,
    rag: !!opts.rag,
  });
}

async function cmdAsk(opts) {
  const query = opts._.join(' ').trim();
  if (!query) die('missing question to ask. Usage: mdss ask [--db <dir>] "question"');

  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const k = opts.k || 5;

  const { askQuestion } = await import('../dist/rag.js');
  const result = await askQuestion({
    query,
    indexDir,
    cacheDir,
    k,
    llmEndpoint: opts.llmEndpoint,
    llmModel: opts.llmModel,
    systemPrompt: opts.systemPrompt,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n${result.answer}\n\n`);
  if (result.citations && result.citations.length > 0) {
    process.stdout.write('Sources:\n');
    for (const c of result.citations) {
      const heading = c.heading ? ` › ${c.heading}` : '';
      process.stdout.write(`  - ${c.file}${heading} [score: ${c.score.toFixed(3)}]\n`);
    }
    process.stdout.write('\n');
  }
}

async function cmdSearch(opts) {
  if (opts.interactive) return cmdTui(opts);
  const cacheDir = resolveCache(opts);
  const query = opts._.join(' ').trim();
  if (!query) die('Missing query text. e.g. mdss search --db ./docs "your question"');

  let results;
  const isFederated = Array.isArray(opts.vaults) && opts.vaults.length > 0;

  if (isFederated) {
    results = await searchFederated({
      vaults: opts.vaults,
      cacheDir,
      query,
      k: opts.k || 6,
      semanticOnly: !!opts.semantic,
      offline: resolveOffline(opts),
      path: opts.path.length > 0 ? opts.path : undefined,
      since: opts.since,
      rerank: !!opts.rerank,
      tag: opts.tag,
      project: opts.project,
      type: opts.type,
      status: opts.status,
      canonicalOnly: opts.canonical,
      explain: !!opts.explain,
      maxPerFile: opts.maxPerFile || opts.maxPerDoc,
      ann: opts.ann,
      nprobe: opts.nprobe,
      graphBoost: opts.graphBoost,
      filter: opts.filter,
    });
  } else {
    const db = resolveDb(opts);
    const indexDir = resolveIndexDir(opts, db);

    results = await search({
      indexDir, cacheDir, query,
      k: opts.k || 6,
      semanticOnly: !!opts.semantic,
      offline: resolveOffline(opts),
      path: opts.path.length > 0 ? opts.path : undefined,
      since: opts.since,
      rerank: !!opts.rerank,
      tag: opts.tag,
      project: opts.project,
      type: opts.type,
      status: opts.status,
      canonicalOnly: opts.canonical,
      explain: !!opts.explain,
      maxPerFile: opts.maxPerFile || opts.maxPerDoc,
      ann: opts.ann,
      nprobe: opts.nprobe,
      graphBoost: opts.graphBoost,
      filter: opts.filter,
    });
  }

  if (opts.json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
  if (results.length === 0) { process.stdout.write('No matches.\n'); return; }

  process.stdout.write(`\nTop ${results.length} for: "${query}"\n\n`);

  // Group by file (issue #13): each file becomes a header with its hits below.
  const byFile = new Map();
  for (const r of results) {
    const fileKey = r.vault ? `[${r.vault}] ${r.file}` : r.file;
    if (!byFile.has(fileKey)) byFile.set(fileKey, []);
    byFile.get(fileKey).push(r);
  }
  const color = !!process.stdout.isTTY; // bold matched terms only on a real terminal
  let rank = 0;
  for (const [fileHeader, hits] of byFile) {
    process.stdout.write(`${fileHeader}\n`);
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
    const pooling = m.pooling ?? 'mean';
    const normalized = m.normalize !== false ? 'L2' : 'raw';
    const rev = m.revision ? ` · rev ${m.revision.slice(0, 8)}` : '';
    process.stdout.write(
      `  ${alias}${star}\n` +
      `    ${m.id} · dim ${m.dim}${rev}\n` +
      `    ${pooling} · ${normalized} · maxTokens ${m.maxTokens ?? '—'} ` +
      (m.family ? `· family ${m.family}\n` : '\n') +
      `    ${m.note}\n\n`,
    );
  }
  process.stdout.write(
    'Pass a registered id or alias to use a built-in adapter. A raw Hugging Face\n' +
    'id is NOT guessed to be E5-compatible: it fails at embed time until an\n' +
    'explicit adapter descriptor is supplied (see README "How to add a model").\n',
  );
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
    watchInterval: opts.watchInterval,
    watchDelay: opts.watchDelay,
    apiKey: opts.apiKey || process.env.MDSS_API_KEY,
    healthPublic: !!opts.healthPublic || process.env.MDSS_HEALTH_PUBLIC === 'true',
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

async function cmdMcp(opts) {
  if (opts.listTools) {
    const { MCP_TOOLS } = await import('../dist/mcp.js');
    process.stdout.write(JSON.stringify(MCP_TOOLS, null, 2) + '\n');
    return;
  }
  const db = resolveDb(opts);
  const indexDir = resolveIndexDir(opts, db);
  const cacheDir = resolveCache(opts);
  const log = s => process.stderr.write(s + '\n');
  const { startMcpServer } = await import('../dist/mcp.js');
  await startMcpServer({
    db, indexDir, cacheDir,
    modelName: opts.model || DEFAULT_MODEL,
    ignore: opts.ignore,
    offline: resolveOffline(opts),
    log,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const configPath = findConfigFile(opts.config);
  const loadedConfig = loadConfigFile(configPath);
  if (loadedConfig.error && opts.config) {
    die(loadedConfig.error);
  }
  opts._config = loadedConfig;
  applyConfigDefaults(opts, loadedConfig.config);

  const cmd = opts._.shift();

  if (opts.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (opts.help || !cmd) { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'index': return cmdIndex(opts);
    case 'stats': return cmdStats(opts);
    case 'check':
    case 'doctor': return cmdCheck(opts);
    case 'export': return cmdExport(opts);
    case 'search': return cmdSearch(opts);
    case 'ask': return cmdAsk(opts);
    case 'tui': return cmdTui(opts);
    case 'serve': return cmdServe(opts);
    case 'mcp': return cmdMcp(opts);
    case 'models': return cmdModels();
    default: die(`unknown command: ${cmd}. Try \`mdss --help\`.`);
  }
}

/**
 * True only when this module is the process entry script (`node bin/cli.mjs`,
 * global `mdss`), never when imported by tests or library consumers (issue #29).
 *
 * The comparison goes through fs.realpathSync on BOTH sides of the identity:
 * on Windows a global install is an NTFS junction, so Node resolves this module
 * to its real path (D:\Repo\...\bin\cli.mjs) while process.argv[1] keeps the
 * junction path (C:\...\npm\node_modules\md-semantic-search\bin\cli.mjs). A
 * plain string comparison then never matches and the CLI silently does nothing.
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] vanished between spawn and here (or is not a real file) —
    // fall back to lexical resolution so behavior matches the old guard.
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  }
}

if (isDirectRun()) {
  main().catch(e => die(e.message));
}

// Exported for the CLI harness tests (issue #29): the pure argument/resolution
// functions are unit-tested directly; die() is asserted via a mocked
// process.exit so a bad flag cannot kill the test runner.
export {
  parseArgs, nextInt, nextFloat, nextValue,
  resolveDb, resolveIndexDir, resolveCache, resolveOffline,
  findConfigFile, loadConfigFile, applyConfigDefaults, KNOWN_CONFIG_KEYS,
  checkHealth, cmdExport,
  die, main, HELP, VERSION,
};

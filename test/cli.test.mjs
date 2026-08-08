import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, nextInt, nextValue,
  resolveDb, resolveIndexDir, resolveCache, resolveOffline,
  die, HELP,
} from '../bin/cli.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-cli-${prefix}-`));
}

// ---- unit tests for the pure argument/resolution functions (issue #29) ----

test('parseArgs: flags, positionals, repeatable --ignore/--path, --k int', () => {
  const o = parseArgs(['search', '--db', './docs', '--json', '--k', '8',
    '--ignore', 'log.md', '--ignore', '**/archive/**', '--path', 'docs/**',
    'some query text']);
  assert.equal(o._.join(' '), 'search some query text');
  assert.equal(o.db, './docs');
  assert.equal(o.json, true);
  assert.equal(o.k, 8);
  assert.deepEqual(o.ignore, ['log.md', '**/archive/**']);
  assert.deepEqual(o.path, ['docs/**']);
});

test('parseArgs: boolean flags set true, help/version recognized', () => {
  const o = parseArgs(['--json', '--semantic', '--offline', '--watch', '--rerank', '--version', '--help']);
  assert.equal(o.json && o.semantic && o.offline && o.watch && o.rerank, true);
  assert.equal(o.version, true);
  assert.equal(o.help, true);
});

test('nextValue/nextInt: value extraction and validation', () => {
  assert.equal(nextValue(['v'], 0, '--db'), 'v');
  // nextInt rejects non-integers (issue #8): die() writes to stderr then exits.
  // Mock process.exit to THROW so the test runner survives (die() itself calls
  // the real process.exit, which would kill the test process).
  const origExit = process.exit;
  const origStderr = process.stderr.write;
  const writes = [];
  process.exit = () => { throw new Error('EXIT'); };
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    assert.throws(() => nextInt(['abc'], 0, '--k'), /EXIT/);
    assert.match(writes.join(''), /--k must be a positive integer, got "abc"/);
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderr;
  }
});

test('resolveDb: flag wins, MDSS_DB env fallback, missing → dies', () => {
  const dir = tempDir('db');
  const prev = process.env.MDSS_DB;
  try {
    // explicit flag wins over env
    assert.equal(resolveDb({ db: dir }), path.resolve(dir));
    // env fallback when no flag
    process.env.MDSS_DB = dir;
    assert.equal(resolveDb({}), path.resolve(dir));
    // missing → die (mock process.exit to throw, like nextInt above)
    delete process.env.MDSS_DB;
    const origExit = process.exit;
    const origStderr = process.stderr.write;
    const writes = [];
    process.exit = () => { throw new Error('EXIT'); };
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try {
      assert.throws(() => resolveDb({}), /EXIT/);
      assert.match(writes.join(''), /Missing --db/);
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
  } finally {
    if (prev === undefined) delete process.env.MDSS_DB; else process.env.MDSS_DB = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveIndexDir: flag wins, MDSS_INDEX_DIR fallback, default <db>/.mdss', () => {
  const db = tempDir('idxdb');
  const prev = process.env.MDSS_INDEX_DIR;
  try {
    assert.equal(resolveIndexDir({ indexDir: '/a' }, db), path.resolve('/a'));
    process.env.MDSS_INDEX_DIR = '/b';
    assert.equal(resolveIndexDir({}, db), path.resolve('/b'));
    delete process.env.MDSS_INDEX_DIR;
    assert.equal(resolveIndexDir({}, db), path.join(path.resolve(db), '.mdss'));
  } finally {
    if (prev === undefined) delete process.env.MDSS_INDEX_DIR; else process.env.MDSS_INDEX_DIR = prev;
    fs.rmSync(db, { recursive: true, force: true });
  }
});

test('resolveCache: flag wins, MDSS_CACHE_DIR fallback, default exists', () => {
  const prev = process.env.MDSS_CACHE_DIR;
  try {
    assert.equal(resolveCache({ cacheDir: '/c' }), path.resolve('/c'));
    process.env.MDSS_CACHE_DIR = '/d';
    assert.equal(resolveCache({}), path.resolve('/d'));
    delete process.env.MDSS_CACHE_DIR;
    const d = resolveCache({});
    assert.ok(typeof d === 'string' && d.length > 0, 'default cache dir is a path');
  } finally {
    if (prev === undefined) delete process.env.MDSS_CACHE_DIR; else process.env.MDSS_CACHE_DIR = prev;
  }
});

test('resolveOffline: flag or MDSS_OFFLINE=1', () => {
  const prev = process.env.MDSS_OFFLINE;
  try {
    assert.equal(resolveOffline({ offline: true }), true);
    assert.equal(resolveOffline({}), false);
    process.env.MDSS_OFFLINE = '1';
    assert.equal(resolveOffline({}), true);
  } finally {
    if (prev === undefined) delete process.env.MDSS_OFFLINE; else process.env.MDSS_OFFLINE = prev;
  }
});

test('die: writes "error: <msg>" to stderr and exits 1', () => {
  const origExit = process.exit;
  const origStderr = process.stderr.write;
  const exits = [];
  const writes = [];
  process.exit = (code) => { exits.push(code); throw new Error('EXIT'); };
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    assert.throws(() => die('boom'), /EXIT/, 'die calls process.exit(1)');
    assert.equal(exits.length, 1);
    assert.equal(exits[0], 1);
    assert.equal(writes.join(''), 'error: boom\n');
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderr;
  }
});

// ---- subprocess harness: real CLI entry, exit codes + stderr (issue #29) ----

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

test('cli: --version prints the version and exits 0', () => {
  const r = runCli(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cli: --help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Usage:'), 'help contains usage');
  assert.ok(HELP.length > 0);
});

test('cli: models lists the registry and exits 0', () => {
  const r = runCli(['models']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('e5-base'), 'default model listed');
  assert.ok(r.stdout.includes('bge-m3'), 'bge-m3 listed');
});

test('cli: unknown command → exit 1 with clear error', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: unknown command: frobnicate/);
});

test('cli: unknown option → exit 1 with clear error', () => {
  const r = runCli(['search', '--wat', 'q']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: unknown option: --wat/);
});

test('cli: --db /nope → exit 1, "--db is not a directory" (issue #8)', () => {
  const r = runCli(['search', '--db', '/nope', 'q']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: --db is not a directory: .*nope/);
});

test('cli: --k abc → exit 1 with "--k must be a positive integer" (issue #8)', () => {
  const dir = tempDir('k');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# X\n\ntext\n');
    const r = runCli(['search', '--db', dir, '--k', 'abc', 'q']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: --k must be a positive integer, got "abc"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: missing --db (and no MDSS_DB) → exit 1 with "Missing --db"', () => {
  const r = runCli(['search', 'q'], { MDSS_DB: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: Missing --db/);
});

test('cli: MDSS_DB env is honored when --db is absent (env precedence)', () => {
  const dir = tempDir('env');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# X\n\ntext\n');
    const r = runCli(['search', 'q'], { MDSS_DB: dir });
    // --db absent → MDSS_DB used → index missing under <dir>/.mdss → the
    // resolved path in the error proves the env fallback fired (issue #29)
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: No index at .*mdss-cli-env-.*\.mdss[\\/]vectors\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: search with an existing index dir but missing vectors.json → clear "No index" error', () => {
  const dir = tempDir('noindex');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# X\n\ntext\n');
    const r = runCli(['search', '--db', dir, 'q']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: No index at .*vectors\.json\. Run `mdss index` first\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: serve --db /nope → exit 1 before binding (path validated)', () => {
  const r = runCli(['serve', '--db', '/nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: --db is not a directory: .*nope/);
});

// ---- mdss stats (issue #21) — machine-readable index stats, no model load ----

/** Write a minimal vectors.json + .hashes.json pair so `mdss stats` has
 * something to parse WITHOUT downloading the embedding model. */
function writeFakeIndex(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, '.mdss'), { recursive: true });
  const built = extra.built || new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(dir, '.mdss', 'vectors.json'), JSON.stringify({
    format: 'binary-v1',
    model: 'Xenova/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 768,
    db: dir,
    built,
    chunkCount: 42,
    chunks: [
      { file: 'a.md', heading: 'A', text: 'a', vec: 'AAAA' },
      { file: 'b.md', heading: 'B', text: 'b', vec: 'BBBB' },
    ],
    ...extra,
  }));
  fs.writeFileSync(path.join(dir, '.mdss', '.hashes.json'), JSON.stringify(
    { 'a.md': 'h1', 'b.md': 'h2', 'c.md': 'h3' }));
}

test('cli: stats --json emits machine-readable fields (issue #21)', () => {
  const dir = tempDir('stats');
  try {
    writeFakeIndex(dir);
    const r = runCli(['stats', '--db', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.format, 'binary-v1');
    assert.equal(s.model, 'Xenova/multilingual-e5-base@main');
    assert.equal(s.modelAlias, 'e5-base');
    assert.equal(s.dim, 768);
    assert.equal(s.chunks, 42);
    assert.equal(s.files, 3, 'file count from .hashes.json keys');
    assert.ok(s.indexBytes > 0, 'vectors.json size reported');
    assert.ok(s.ageSeconds > 0 && s.ageSeconds < 120, `age ~60s, got ${s.ageSeconds}`);
    assert.equal(s.db, dir);
    assert.ok(s.indexDir.endsWith('.mdss'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: stats human output shows format/model/chunks/files/built', () => {
  const dir = tempDir('stats-h');
  try {
    writeFakeIndex(dir);
    const r = runCli(['stats', '--db', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /format: binary-v1/);
    assert.match(r.stdout, /model: e5-base \(dim 768\)/);
    assert.match(r.stdout, /chunks: 42 · files: 3/);
    assert.match(r.stdout, /built: .+ ago/);
    assert.match(r.stdout, /db: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: stats falls back to unique chunk files when .hashes.json is missing', () => {
  const dir = tempDir('stats-nohash');
  try {
    writeFakeIndex(dir);
    fs.rmSync(path.join(dir, '.mdss', '.hashes.json'));
    const r = runCli(['stats', '--db', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).files, 2, 'from chunk file paths');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: stats with no index → exit 1, clear "No index" error', () => {
  const dir = tempDir('stats-noindex');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# X\n\ntext\n');
    const r = runCli(['stats', '--db', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: No index at .*vectors\.json\. Run `mdss index` first\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: stats with corrupt vectors.json → exit 1, clear JSON error', () => {
  const dir = tempDir('stats-corrupt');
  try {
    fs.mkdirSync(path.join(dir, '.mdss'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.mdss', 'vectors.json'), '{ not json');
    const r = runCli(['stats', '--db', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: .*vectors\.json is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- mdss index --json (issue #21) — build result as JSON for scripts ----

test('cli: index --json on an empty db → exit 0 with JSON build result (no model load)', () => {
  const dir = tempDir('idxjson');
  try {
    const r = runCli(['index', '--db', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.files, 0);
    assert.equal(j.chunks, 0);
    assert.equal(j.embedded, 0);
    assert.ok(j.vectorsPath.endsWith('vectors.json'), 'vectorsPath present');
    assert.equal(j.dim, 768, 'dim from resolved default model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

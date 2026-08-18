import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '../dist/core.js';
import {
  parseArgs, nextInt, nextFloat, nextValue,
  resolveDb, resolveIndexDir, resolveCache, resolveOffline,
  die, HELP,
} from '../bin/cli.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-cli-${prefix}-`));
}

// ---- unit tests for the pure argument/resolution functions (issue #29) ----

test('parseArgs: flags, positionals, repeatable --ignore/--path/--vault, --k int, --graph-boost float, --filter string', () => {
  const o = parseArgs(['search', '--db', './docs', '--json', '--k', '8', '--graph-boost', '0.75',
    '--filter', 'tag:engineering AND status != archived',
    '--vault', './vault1', '--vault', './vault2',
    '--ignore', 'log.md', '--ignore', '**/archive/**', '--path', 'docs/**',
    'some query text']);
  assert.equal(o._.join(' '), 'search some query text');
  assert.equal(o.db, './docs');
  assert.equal(o.json, true);
  assert.equal(o.k, 8);
  assert.equal(o.graphBoost, 0.75);
  assert.equal(o.filter, 'tag:engineering AND status != archived');
  assert.deepEqual(o.vaults, ['./vault1', './vault2']);
  assert.deepEqual(o.ignore, ['log.md', '**/archive/**']);
  assert.deepEqual(o.path, ['docs/**']);
});

test('parseArgs: boolean flags set true, help/version recognized', () => {
  const o = parseArgs(['--json', '--semantic', '--offline', '--watch', '--rerank', '--rag', '--auto-tag', '--auto-summarize', '--version', '--help']);
  assert.equal(o.json && o.semantic && o.offline && o.watch && o.rerank && o.rag && o.autoTag && o.autoSummarize, true);
  assert.equal(o.version, true);
  assert.equal(o.help, true);
});

test('nextValue/nextInt/nextFloat: value extraction and validation', () => {
  assert.equal(nextValue(['v'], 0, '--db'), 'v');
  assert.equal(nextFloat(['0.5'], 0, '--graph-boost'), 0.5);
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
    const pathA = path.join(db, 'a');
    const pathB = path.join(db, 'b');
    assert.equal(resolveIndexDir({ indexDir: pathA }, db), path.resolve(pathA));
    process.env.MDSS_INDEX_DIR = pathB;
    assert.equal(resolveIndexDir({}, db), path.resolve(pathB));
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

test('cli: models lists the Qwen3 profile and retains e5-base as default', () => {
  // Given
  const expectedAlias = 'qwen3-embedding-0.6b';
  const expectedId = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

  // When
  const r = runCli(['models']);

  // Then
  assert.equal(r.status, 0);
  assert.match(r.stdout, /e5-base \(default\)/);
  assert.ok(r.stdout.includes(expectedAlias), 'Qwen3 alias listed');
  assert.ok(r.stdout.includes(expectedId), 'Qwen3 repository id listed');
  assert.match(r.stdout, /qwen3-embedding-0\.6b[^]*?dim 1024/);
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
    schemaVersion: SCHEMA_VERSION,
    format: 'binary-v1',
    lexical: { format: 'bm25-v1', documentLengths: [1, 1], postings: { aa: [[0, 1]], bb: [[1, 1]] } },
    model: 'Xenova/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 768,
    db: dir,
    built,
    chunkCount: 2,
    chunks: [
      { file: 'a.md', title: 'A', heading: 'A', headingPath: ['A'], text: 'a', chunkHash: 'ha', vec: Buffer.alloc(768 * 4).toString('base64') },
      { file: 'b.md', title: 'B', heading: 'B', headingPath: ['B'], text: 'b', chunkHash: 'hb', vec: Buffer.alloc(768 * 4).toString('base64') },
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
    assert.equal(s.schemaVersion, SCHEMA_VERSION);
    assert.equal(s.lexicalFormat, 'bm25-v1');
    assert.equal(s.lexicalStatus, 'persisted-bm25');
    assert.equal(s.model, 'Xenova/multilingual-e5-base@main');
    assert.equal(s.modelAlias, 'e5-base');
    assert.equal(s.dim, 768);
    assert.equal(s.chunks, 2);
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
    assert.match(r.stdout, /schema: v3 · lexical: bm25-v1/);
    assert.match(r.stdout, /model: e5-base \(dim 768\)/);
    assert.match(r.stdout, /chunks: 2 · files: 3/);
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

test('cli: index under a held index lock → exit 1 with a clear "locked by pid" hint (issue #37)', () => {
  const dir = tempDir('idxlock');
  const idxDir = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# X\n\ntext\n');
    // Simulate a concurrent writer: a live THIS-process lock in the index dir.
    // The CLI runs in a subprocess (different pid), so our lock reads "held by
    // pid <this test's pid>" there — exactly the concurrent-mdss scenario.
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(path.join(idxDir, '.mdss.lock'),
      JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n');
    const r = runCli(['index', '--db', dir]);
    assert.equal(r.status, 1, 'a held lock is an error, not a silent wait');
    assert.match(r.stderr, /being written by pid \d+/, 'names the holder');
    assert.match(r.stderr, /Another mdss process is writing/, 'actionable hint');
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

// ---- mdss check / doctor (issue #43) — offline diagnostics -----------------
// Unit tests call checkHealth() directly (no model, no network); two CLI-level
// tests assert exit codes and the human/JSON output contract.

import { checkHealth } from '../bin/cli.mjs';

/** Minimal synthetic index dir: 1 file, 1 chunk, dim=4 binary vecs. */
function makeIndexDir(db, { schemaVersion = SCHEMA_VERSION, vec = [0.1, 0.2, 0.3, 0.4], dim = 4,
  model = 'Xenova/all-MiniLM-L6-v2', built, chunks, lexical } = {}) {
  const indexDir = path.join(db, '.mdss');
  fs.mkdirSync(indexDir, { recursive: true });
  const b64 = vec ? Buffer.from(new Float32Array(vec).buffer).toString('base64') : undefined;
  const index = {
    schemaVersion, format: 'binary-v1', model, dim,
    built: built || new Date().toISOString(),
    chunkCount: chunks?.length ?? 1,
    chunks: chunks ?? [{ file: 'a.md', title: 'A', heading: 'A', headingPath: ['A'], text: 'text', chunkHash: 'hash-a', vec: b64 }],
  };
  if (schemaVersion === 3) {
    index.lexical = lexical ?? { format: 'bm25-v1', documentLengths: [2], postings: { text: [[0, 1]], aa: [[0, 1]] } };
  }
  fs.writeFileSync(path.join(indexDir, 'vectors.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(indexDir, '.hashes.json'), JSON.stringify({ 'a.md': 'h' }));
  return indexDir;
}

test('checkHealth: healthy index + db → healthy=true, all sections ok', () => {
  const dir = tempDir('check-ok');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, true);
    assert.equal(r.index.parses, true);
    assert.equal(r.index.recognized, true);
    assert.equal(r.chunks.valid, 1);
    assert.equal(r.chunks.invalid.length, 0);
    assert.equal(r.db.stale, false);
    assert.equal(r.model.id, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(r.model.cached, false); // cache dir is empty
    assert.match(r.model.error, /cache.*Xenova[\\/]all-MiniLM-L6-v2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: no index → healthy=false, actionable error', () => {
  const dir = tempDir('check-noidx');
  try {
    const r = checkHealth({
      db: dir, indexDir: path.join(dir, '.mdss'), cacheDir: path.join(dir, 'cache'),
    });
    assert.equal(r.healthy, false);
    assert.equal(r.index.exists, false);
    assert.match(r.index.error, /Run `mdss index` first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: corrupt vector (dim mismatch) named, exit-worthy', () => {
  const dir = tempDir('check-corrupt');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { vec: [1, 2], dim: 4 }); // 2 dims ≠ 4
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, false);
    assert.equal(r.chunks.valid, 0);
    assert.equal(r.chunks.invalid.length, 1);
    assert.equal(r.chunks.invalid[0].where, 'a.md › A');
    assert.match(r.chunks.invalid[0].error, /2 dims, expected 4/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: vec-less legacy chunk is flagged, not skipped', () => {
  const dir = tempDir('check-vecless');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { schemaVersion: 2, chunks: [{ file: 'a.md', heading: 'A' }] });
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, false);
    assert.match(r.chunks.invalid[0].error, /missing vector/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: stale db (newer mtime than built) → db.stale', () => {
  const dir = tempDir('check-stale');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { built: new Date(Date.now() - 3600e3).toISOString() });
    const future = new Date(Date.now() + 60e3); // far beyond the 5s grace window
    fs.utimesSync(path.join(dir, 'a.md'), future, future);
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, false);
    assert.equal(r.db.stale, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: unknown newer schemaVersion → index.recognized=false', () => {
  const dir = tempDir('check-schema');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { schemaVersion: 99 });
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, false);
    assert.equal(r.index.recognized, false);
    assert.match(r.index.error, /v99.*newer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: malformed root/schema/chunks and known-model dimension are actionable', () => {
  const dir = tempDir('check-boundaries');
  const vectorsPath = path.join(dir, '.mdss', 'vectors.json');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    for (const schemaVersion of ['3', 3.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
      fs.writeFileSync(vectorsPath, JSON.stringify({ ...current, schemaVersion }));
      const report = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
      assert.equal(report.healthy, false);
      assert.match(report.index.error, /schemaVersion must be a non-negative safe integer.*mdss index/i);
      makeIndexDir(dir);
    }
    fs.writeFileSync(vectorsPath, JSON.stringify(null));
    assert.match(checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') }).index.error,
      /root must be an object.*mdss index/i);
    fs.writeFileSync(vectorsPath, JSON.stringify({ schemaVersion: 3, chunks: null }));
    assert.match(checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') }).index.error,
      /chunks must be an array.*mdss index/i);
    fs.writeFileSync(vectorsPath, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, chunks: null }));
    assert.match(checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') }).index.error,
      /schema v4.*newer.*upgrade/i);
    makeIndexDir(dir);
    const known = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    known.model = 'Xenova/multilingual-e5-base@main';
    known.modelAlias = 'e5-base';
    known.dim = 4;
    fs.writeFileSync(vectorsPath, JSON.stringify(known));
    assert.match(checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') }).index.error,
      /index\.dim 4 does not match known model dimension 768.*mdss index/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: genuine v3 missing or malformed lexical data is unhealthy', () => {
  const dir = tempDir('check-lexical');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { lexical: { format: 'bm25-v1', documentLengths: [], postings: {} } });
    const malformed = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(malformed.healthy, false);
    assert.match(malformed.index.error, /lexical.*mdss index/i);

    const index = JSON.parse(fs.readFileSync(path.join(indexDir, 'vectors.json'), 'utf8'));
    delete index.lexical;
    fs.writeFileSync(path.join(indexDir, 'vectors.json'), JSON.stringify(index));
    const missing = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(missing.healthy, false);
    assert.match(missing.index.error, /lexical.*mdss index/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: malformed current chunks, format, and storage match loadIndex failures', () => {
  const dir = tempDir('check-current-envelope');
  const vectorsPath = path.join(dir, '.mdss', 'vectors.json');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    const cases = [
      [{ ...current, format: 'binary-v9' }, /format must be binary-v1/i],
      [{ ...current, chunks: [null], chunkCount: 1 }, /chunk 0 must be an object/i],
      [{ ...current, chunks: [{ ...current.chunks[0], file: 47 }] }, /chunk 0 file must be a string/i],
      [{ ...current, chunks: [{ ...current.chunks[0], vec: '' }] }, /base64 vector.*empty/i],
      [{ ...current, chunks: [{ ...current.chunks[0], vec: '!!!!' }] }, /base64 vector.*canonical/i],
    ];
    for (const [value, expected] of cases) {
      fs.writeFileSync(vectorsPath, JSON.stringify(value));
      const report = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
      assert.equal(report.healthy, false);
      const error = report.index.error ?? report.chunks.invalid[0]?.error ?? '';
      assert.match(error, expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: missing model cache fails only with requireOffline', () => {
  const dir = tempDir('check-offline');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    const cacheDir = path.join(dir, 'cache');
    const soft = checkHealth({ db: dir, indexDir, cacheDir });
    assert.equal(soft.healthy, true, 'warning by default');
    assert.equal(soft.model.cached, false);
    const hard = checkHealth({ db: dir, indexDir, cacheDir, requireOffline: true });
    assert.equal(hard.healthy, false, 'failure under --offline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: main model cache follows Transformers.js FileCache layout', () => {
  const dir = tempDir('check-cache-main');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { model: 'Xenova/all-MiniLM-L6-v2' });
    const cacheDir = path.join(dir, 'cache');
    const modelPath = path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2');
    fs.mkdirSync(modelPath, { recursive: true });
    fs.writeFileSync(path.join(modelPath, 'config.json'), '{}');
    const r = checkHealth({ db: dir, indexDir, cacheDir, requireOffline: true });
    assert.equal(r.model.id, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(r.model.cachePath, modelPath);
    assert.equal(r.model.cached, true);
    assert.equal(r.healthy, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: pinned model cache follows revision subdirectory', () => {
  const dir = tempDir('check-cache-pinned');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const revision = 'abc123';
    const indexDir = makeIndexDir(dir, { model: `Xenova/all-MiniLM-L6-v2@${revision}` });
    const cacheDir = path.join(dir, 'cache');
    const modelPath = path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2', revision);
    fs.mkdirSync(modelPath, { recursive: true });
    fs.writeFileSync(path.join(modelPath, 'config.json'), '{}');
    const r = checkHealth({ db: dir, indexDir, cacheDir, requireOffline: true });
    assert.equal(r.model.id, `Xenova/all-MiniLM-L6-v2@${revision}`);
    assert.equal(r.model.cachePath, modelPath);
    assert.equal(r.model.cached, true);
    assert.equal(r.healthy, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkHealth: unparsable .hashes.json → healthy=false', () => {
  const dir = tempDir('check-hashes');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    fs.writeFileSync(path.join(indexDir, '.hashes.json'), '{oops');
    const r = checkHealth({ db: dir, indexDir, cacheDir: path.join(dir, 'cache') });
    assert.equal(r.healthy, false);
    assert.equal(r.hashes.parses, false);
    assert.match(r.hashes.error, /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: check on db without index → exit 1 with actionable message (issue #43)', () => {
  const dir = tempDir('check-cli');
  try {
    const r = runCli(['check', '--db', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL.*Run `mdss index` first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: doctor alias + --json → exit 0 with healthy report (issue #43)', () => {
  const dir = tempDir('check-cli-json');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    makeIndexDir(dir);
    const r = runCli(['doctor', '--db', dir, '--json'],
      { MDSS_CACHE_DIR: path.join(dir, 'cache') });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.healthy, true);
    assert.equal(j.chunks.valid, 1);
    assert.equal(j.model.cached, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: human check prints malformed v3 lexical and schema errors as FAIL', () => {
  const dir = tempDir('check-cli-errors');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir, { lexical: { format: 'bm25-v1', documentLengths: [], postings: {} } });
    const lexical = runCli(['check', '--db', dir]);
    assert.equal(lexical.status, 1);
    assert.match(lexical.stdout, /FAIL.*schema v3 lexical index.*mdss index.*rebuild/i);

    const current = JSON.parse(fs.readFileSync(path.join(indexDir, 'vectors.json'), 'utf8'));
    current.schemaVersion = '3';
    fs.writeFileSync(path.join(indexDir, 'vectors.json'), JSON.stringify(current));
    const schema = runCli(['doctor', '--db', dir]);
    assert.equal(schema.status, 1);
    assert.match(schema.stdout, /FAIL.*schemaVersion must be a non-negative safe integer.*mdss index/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: check and stats reject invalid current format and vector storage', () => {
  const dir = tempDir('cli-current-format');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\ntext\n');
    const indexDir = makeIndexDir(dir);
    const vectorsPath = path.join(indexDir, 'vectors.json');
    const current = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    const cases = [
      [{ ...current, format: 'binary-v9' }, /format must be binary-v1/i],
      [{ ...current, chunks: [{ ...current.chunks[0], vec: '!!!!' }] }, /base64 vector.*canonical/i],
      [{ ...current, chunkCount: undefined }, /chunkCount must equal chunks\.length/i],
      [{ ...current, model: undefined }, /schema v3 model must be a nonempty string/i],
      [{ ...current, model: '' }, /schema v3 model must be a nonempty string/i],
    ];
    for (const [value, expected] of cases) {
      fs.writeFileSync(vectorsPath, JSON.stringify(value));
      const check = runCli(['check', '--db', dir]);
      assert.equal(check.status, 1);
      assert.match(check.stdout, new RegExp(`FAIL[\\s\\S]*${expected.source}`, 'i'));
      assert.doesNotMatch(check.stdout, /ok\s+chunks:/i,
        'invalid current envelopes do not report uncheckable chunks as healthy');
      const stats = runCli(['stats', '--db', dir, '--json']);
      assert.equal(stats.status, 1);
      assert.match(stats.stderr, expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

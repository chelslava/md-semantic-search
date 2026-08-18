#!/usr/bin/env node
// @ts-check
/**
 * Release provenance smoke for md-semantic-search (issue #55).
 *
 * Proves that the PACKED artifact (the thing npm installs / CI publishes) —
 * not just the source tree — contains the expected CLI, exposes the documented
 * commands/options, reports the exact packaged version, export the documented
 * public library API, and actually works through the real binary shim.
 *
 * Steps:
 *   1. `npm pack` into a temp dir → record the tarball name + shasum.
 *   2. Install that tarball into an isolated temp prefix (no global state).
 *   3. Invoke the installed `mdss` bin shim directly:
 *        - `--version`  == package.json version,
 *        - `--help`     contains the current commands/options.
 *   4. Import the packed library (main points at the installed src) and assert
 *      the documented exports exist.
 *   5. OPTIONAL real-model smoke (when MPI_RUN_REAL_MODEL=1): build a tiny index
 *      with e5-small through the installed CLI, then `stats --json` and
 *      `check --json` against it. Skipped by default so push-CI stays
 *      network-free/fast; the nightly/scheduled job sets the flag.
 *
 * Exit 0 on success; non-zero with a diagnostic on the first failure.
 *
 * Set MDSS_VERIFY_KEEP=1 to leave the temp prefix on disk for inspection.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const RUN_REAL = process.env.MDSS_RUN_REAL_MODEL === '1';
const KEEP = process.env.MDSS_VERIFY_KEEP === '1';

const $ = (cmd, args, opts = {}) => {
  // On win32 npm is a .cmd batch file which spawnSync cannot execute without a
  // shell. Linux/macOS keep NO shell so args are passed verbatim (no quoting
  // surprises).
  const isWinNpm = /^win/.test(process.platform) && /npm/i.test(cmd);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', env: process.env, ...opts,
    ...(isWinNpm ? { shell: true } : {}),
  });
  return r;
};

const fail = (msg) => {
  process.stderr.write(`\nFAIL: ${msg}\n`);
  process.exitCode = 1;
  process.disconnect?.();
};

/** @returns {string} temp dir (or "" if it should not be cleaned) */
function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-verify-${name}-`));
}

const cleanup = (dir) => {
  if (!dir || KEEP) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  console.log('mdss provenance verify');
  console.log(`  repo: ${REPO_ROOT}`);
  console.log(`  version (package.json): ${PKG_JSON.version}`);
  console.log(`  real-model smoke: ${RUN_REAL ? 'ON' : 'OFF (skip, fast)'}`);

  // ---- 1. npm pack into a scratch dir --------------------------------
  const packDir = tmp('pack');
  try {
    console.log(`\n[1] packing into ${packDir}`);
    // Use the npm CLI; deterministic enough for provenance.
    const packRun = $(/^win/.test(process.platform) ? 'npm.cmd' : 'npm',
      ['pack', '--json', '--pack-destination', packDir], { cwd: REPO_ROOT });
    if (packRun.status !== 0) {
      fail(`npm pack failed:\n${packRun.stderr}`);
      process.exit(1);
    }
    const packJson = JSON.parse(packRun.stdout.trim()); // maybe single or array
    const entries = Array.isArray(packJson) ? packJson : [packJson];
    const entry = entries[0];
    const tarball = path.join(packDir, entry.filename);
    const shasum = crypto.createHash('sha256')
      .update(fs.readFileSync(tarball)).digest('hex');
    console.log(`  tarball : ${entry.filename}`);
    console.log(`  files   : ${entry.files?.length ?? '?'}`);
    console.log(`  size    : ${entry.size} bytes`);
    console.log(`  sha256  : ${shasum}`);

    // ---- 2. isolated install ----------------------------------------
    console.log(`\n[2] installing tarball into isolated prefix`);
    const prefix = tmp('prefix');
    const install = $(/^win/.test(process.platform) ? 'npm.cmd' : 'npm',
      ['install', '--prefix', prefix, tarball], { cwd: packDir });
    if (install.status !== 0) {
      fail(`isolated install failed:\n${install.stderr}`);
      process.exit(1);
    }
    const installedPkg = path.join(prefix, 'node_modules', 'md-semantic-search');
    if (!fs.existsSync(installedPkg)) {
      fail(`installed package dir not found at ${installedPkg}`);
      process.exit(1);
    }
    const binShim = path.join(installedPkg, 'bin', 'cli.mjs');
    if (!fs.existsSync(binShim)) {
      fail(`installed bin shim missing: ${binShim}`);
      process.exit(1);
    }

    // ---- 3. real shim: --version + --help ---------------------------
    console.log('\n[3] smoke the installed mdss shim');
    const runShim = (args, extraEnv = {}) =>
      $(process.execPath, [binShim, ...args], {
        env: { ...process.env, ...extraEnv },
      });

    const ver = runShim(['--version']);
    if (ver.status !== 0) fail(`--version exited ${ver.status}: ${ver.stderr || ver.stdout}`);
    else if (ver.stdout.trim() !== PKG_JSON.version) {
      fail(`--version "${ver.stdout.trim()}" != package.json "${PKG_JSON.version}"`);
    } else {
      console.log(`  --version => ${ver.stdout.trim()} (matches package.json)`);
    }

    const help = runShim(['--help']);
    if (help.status !== 0) {
      fail(`--help exited ${help.status}: ${help.stderr || help.stdout}`);
    } else {
      const needed = ['index', 'search', 'stats', 'check', 'serve', 'models',
        '--rerank', '--offline', '--version', '--json'];
      const missing = needed.filter(t => !help.stdout.includes(t));
      if (missing.length > 0) {
        fail(`--help missing tokens: ${missing.join(', ')}`);
      } else {
        console.log(`  --help exposes ${needed.length} commands/options ✓`);
      }
    }

    // ---- 4. packed library exports -----------------------------------
    console.log('\n[4] verify installed library exports');
    const lib = await import(pathToFileURL(path.join(installedPkg, 'dist', 'index.js')).href);
    const expected = ['buildIndex', 'search', 'loadIndex', 'searchIndex',
      'resolveModel', 'MODELS', 'DEFAULT_MODEL', 'chunkHash', 'tokenize',
      'keywordScores', 'rrf', 'embed', 'getExtractor', 'cosine',
      'walkMarkdown', 'parseFile', 'chunkMarkdown', 'splitFrontmatter',
      'extractTitle', 'globToRegExp', 'encodeVec', 'decodeVec',
      'getReranker', 'rerankScores', 'normalizeAdapter',
      'embeddingAdapterFingerprint', 'quantizeToInt8', 'dequantizeFromInt8', 'asymmetricCosineInt8',
      'searchFederated', 'createFileWatcher'];
    const missingExports = expected.filter((name) => !(name in lib));
    if (missingExports.length > 0) {
      fail(`installed library exports missing: ${missingExports.join(', ')}`);
    } else {
      console.log(`  ${expected.length} documented exports present ✓`);
    }

    // ---- 5. optional real-model CLI smoke ----------------------------
    if (RUN_REAL) {
      console.log('\n[5] real-model CLI smoke (index → stats → check)');
      const db = tmp('db');
      fs.mkdirSync(path.join(db, 'docs'));
      fs.writeFileSync(path.join(db, 'docs', 'one.md'),
        '# One\n\n## Section\n\nunique content about credential rotation and tokens\n');
      fs.writeFileSync(path.join(db, 'docs', 'two.md'),
        '# Two\n\n## Banana\n\nfruit baking temperature time\n');
      const indexDir = path.join(db, 'index');
      // Reuse a CI-provided model cache (nightly workflow caches it) so
      // scheduled runs don't re-download 120MB every night; otherwise use a
      // throwaway cache inside the temp db dir.
      const cacheDir = process.env.MDSS_NIGHTLY_CACHE_DIR ||
        path.join(db, 'cache');
      if (process.env.MDSS_NIGHTLY_CACHE_DIR) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const idx = runShim(['index', '--db', path.join(db, 'docs'),
        '--index-dir', indexDir, '--cache-dir', cacheDir, '--model', 'e5-small'],
        { MDSS_CACHE_DIR: cacheDir });
      if (idx.status !== 0) {
        fail(`installed CLI index failed: ${idx.stderr || idx.stdout}`);
      } else {
        const stats = runShim(['stats', '--db', path.join(db, 'docs'),
          '--index-dir', indexDir, '--json']);
        if (stats.status !== 0) fail(`installed CLI stats failed: ${stats.stderr || stats.stdout}`);
        else {
          const s = JSON.parse(stats.stdout);
          console.log(`  schemaVersion=${s.schemaVersion} format=${s.format} lexical=${s.lexicalFormat} model=${s.model} dim=${s.dim}`);
          if (s.schemaVersion !== 3) fail(`dogfood index schemaVersion=${s.schemaVersion}, want 3`);
          if (s.lexicalFormat !== 'bm25-v2') fail(`dogfood lexicalFormat=${s.lexicalFormat}, want bm25-v2`);
        }
        const check = runShim(['check', '--db', path.join(db, 'docs'),
          '--index-dir', indexDir, '--json'], { MDSS_CACHE_DIR: cacheDir });
        if (check.status !== 0) fail(`installed CLI check failed: ${check.stderr || check.stdout}`);
        else console.log('  check --json => healthy, exit 0');
      }
      cleanup(db);
    }

    console.log('\nProvenance verification PASSED.');
    cleanup(prefix);
    cleanup(packDir);
    process.exit(0);
  } catch (e) {
    fail(`provenance verify threw: ${e?.stack || e}`);
    process.exit(1);
  } finally {
    // npm pack may have left a stray tarball in REPO_ROOT on abrupt failure.
    try {
      const stray = path.join(REPO_ROOT, `md-semantic-search-${PKG_JSON.version}.tgz`);
      if (fs.existsSync(stray)) fs.unlinkSync(stray);
    } catch { /* ignore */ }
  }
} catch (e) {
  process.stderr.write(`\nFATAL: ${e?.stack || e}\n`);
  process.exit(1);
}
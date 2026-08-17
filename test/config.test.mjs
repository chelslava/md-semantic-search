import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  findConfigFile,
  loadConfigFile,
  applyConfigDefaults,
  checkHealth,
} from '../bin/cli.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('config: parseArgs parses --config flag', () => {
  const opts = parseArgs(['index', '--config', 'custom.config.json', '--db', './notes']);
  assert.equal(opts.config, 'custom.config.json');
  assert.equal(opts.db, './notes');
});

test('config: findConfigFile finds explicit file and respects MDSS_CONFIG', () => {
  const dir = tempDir('cfg-find');
  try {
    const cfgPath = path.join(dir, '.mdssrc.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ db: './my-notes', model: 'bge-m3' }));

    assert.equal(findConfigFile(cfgPath), path.resolve(cfgPath));

    process.env.MDSS_CONFIG = cfgPath;
    assert.equal(findConfigFile(), path.resolve(cfgPath));
    delete process.env.MDSS_CONFIG;
  } finally {
    delete process.env.MDSS_CONFIG;
    safeRm(dir);
  }
});

test('config: loadConfigFile normalizes kebab-case keys and identifies unknown keys', () => {
  const dir = tempDir('cfg-load');
  try {
    const cfgPath = path.join(dir, 'mdss.config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        db: './notes',
        'index-dir': './notes/.my-mdss',
        model: 'e5-base',
        ignore: ['drafts/**', 'archive/**'],
        k: 10,
        'unknown-option': 123,
      })
    );

    const loaded = loadConfigFile(cfgPath);
    assert.equal(loaded.error, null);
    assert.equal(loaded.config.db, './notes');
    assert.equal(loaded.config.indexDir, './notes/.my-mdss');
    assert.equal(loaded.config.model, 'e5-base');
    assert.deepEqual(loaded.config.ignore, ['drafts/**', 'archive/**']);
    assert.equal(loaded.config.k, 10);
    assert.deepEqual(loaded.unknownKeys, ['unknown-option']);
  } finally {
    safeRm(dir);
  }
});

test('config: applyConfigDefaults applies defaults without overriding CLI flags', () => {
  const opts = {
    _: ['search'],
    ignore: ['cli-ignore.md'],
    path: [],
    model: 'bge-m3', // CLI explicit
  };
  const config = {
    db: './docs',
    model: 'e5-base', // Should NOT override CLI
    indexDir: './docs/.mdss',
    ignore: ['config-ignore.md'], // Should NOT override CLI
    k: 8,
  };

  const merged = applyConfigDefaults(opts, config);
  assert.equal(merged.db, './docs');
  assert.equal(merged.model, 'bge-m3'); // Preserved CLI flag
  assert.equal(merged.indexDir, './docs/.mdss');
  assert.deepEqual(merged.ignore, ['cli-ignore.md']); // Preserved CLI flag
  assert.equal(merged.k, 8);
});

test('config: checkHealth validates config schema and flags unknown keys', () => {
  const dir = tempDir('cfg-health');
  const idx = path.join(dir, '.mdss');
  fs.mkdirSync(idx, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.md'), '# Title\n\nContent');

  // Minimal valid index
  const validIndex = {
    schemaVersion: 3,
    format: 'binary-v1',
    model: 'intfloat/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 8,
    db: dir,
    built: new Date().toISOString(),
    chunkCount: 1,
    chunks: [
      {
        file: 'test.md',
        title: 'Title',
        heading: 'Title',
        headingPath: ['Title'],
        text: 'Content',
        vec: Buffer.from(new Float32Array(8).fill(0.1).buffer).toString('base64'),
      },
    ],
  };
  fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(validIndex));

  try {
    const validConfig = {
      path: path.join(dir, '.mdssrc.json'),
      config: { db: dir, model: 'e5-base' },
      unknownKeys: [],
      error: null,
    };
    const repOk = checkHealth({ db: dir, indexDir: idx, cacheDir: dir, config: validConfig });
    assert.equal(repOk.config.valid, true);

    const invalidConfig = {
      path: path.join(dir, '.mdssrc.json'),
      config: { db: dir },
      unknownKeys: ['badKey1', 'badKey2'],
      error: null,
    };
    const repBad = checkHealth({ db: dir, indexDir: idx, cacheDir: dir, config: invalidConfig });
    assert.equal(repBad.config.valid, false);
    assert.equal(repBad.healthy, false);
    assert.ok(repBad.config.error.includes('unknown config keys'));
  } finally {
    safeRm(dir);
  }
});

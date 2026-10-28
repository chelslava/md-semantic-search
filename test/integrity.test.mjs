import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex } from '../dist/search.js';

function fakeEmbed(texts, kind, model) {
  return texts.map((t) => {
    const dim = model?.dim > 0 ? model.dim : 8;
    const v = new Array(dim).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

test('integrity: buildIndex writes vectors.json.sha256 manifest file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-integrity-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'test.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const shaPath = path.join(idx, 'vectors.json.sha256');
    assert.equal(fs.existsSync(shaPath), true, 'vectors.json.sha256 should exist');

    const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
    assert.match(shaContent, /^[a-f0-9]{64}\s+vectors\.json$/);

    // loadIndex succeeds with valid manifest
    const loaded = loadIndex(idx);
    assert.equal(loaded.index.chunks.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrity: valid payload with stale vectors.json sidecar loads with a warning; unparseable payload still fails (issue #187)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-integrity-corrupt-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'test.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const vectorsPath = path.join(idx, 'vectors.json');
    const originalContent = fs.readFileSync(vectorsPath, 'utf8');

    // Tamper with the payload while keeping it VALID JSON, then remove the
    // binary cache so vectors.json is the only load path (issue #187: a valid
    // payload with a stale sidecar loads with a warning — it is the format of
    // record and a crash mid-publish looks exactly like this)
    const corruptedContent = originalContent.replace('Coffee', 'Tea');
    fs.writeFileSync(vectorsPath, corruptedContent);
    try {
      fs.unlinkSync(path.join(idx, 'vectors.bin'));
      fs.unlinkSync(path.join(idx, 'vectors.bin.sha256'));
    } catch {}

    const warnings = captureStderr(() => {
      const loaded = loadIndex(idx);
      assert.equal(loaded.index.chunks.length, 1, 'valid payload still loads');
    });
    assert.match(warnings, /stale sidecar/);
    assert.match(warnings, /check --fix/);

    // an UNPARSEABLE payload must still fail hard (real corruption)
    fs.writeFileSync(vectorsPath, '{ not json at all');
    assert.throws(() => loadIndex(idx), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrity: stale vectors.bin sidecar falls back to vectors.json instead of failing (issue #187)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-integrity-bin-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'test.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const shaBinPath = path.join(idx, 'vectors.bin.sha256');
    assert.equal(fs.existsSync(shaBinPath), true, 'binary sidecar exists');
    // make the binary sidecar stale without touching vectors.json
    fs.writeFileSync(shaBinPath, `${'a'.repeat(64)}  vectors.bin\n`);

    const warnings = captureStderr(() => {
      const loaded = loadIndex(idx);
      assert.equal(loaded.index.chunks.length, 1, 'falls back to vectors.json');
    });
    assert.match(warnings, /ignoring the binary cache/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Capture process.stderr writes made by fn. */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

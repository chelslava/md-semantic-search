import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdExport } from '../bin/cli.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function createSampleIndex(dir) {
  const idx = path.join(dir, '.mdss');
  fs.mkdirSync(idx, { recursive: true });
  fs.writeFileSync(path.join(dir, 'doc1.md'), '# Title\n\nContent');

  const vecData = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const vecBase64 = Buffer.from(vecData.buffer).toString('base64');

  const index = {
    schemaVersion: 3,
    format: 'binary-v1',
    model: 'intfloat/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 4,
    db: dir,
    built: new Date().toISOString(),
    chunkCount: 2,
    chunks: [
      {
        file: 'doc1.md',
        title: 'Title',
        heading: 'Intro',
        headingPath: ['Title', 'Intro'],
        text: 'First chunk text',
        vec: vecBase64,
        chunkHash: 'hash1',
        startLine: 1,
        endLine: 10,
      },
      {
        file: 'doc1.md',
        title: 'Title',
        heading: 'Details, with "quotes"',
        headingPath: ['Title', 'Details, with "quotes"'],
        text: 'Second chunk\nwith newline',
        vec: vecBase64,
        chunkHash: 'hash2',
        startLine: 11,
        endLine: 20,
      },
    ],
  };
  fs.writeFileSync(path.join(idx, 'vectors.json'), JSON.stringify(index));
  return { dir, idx };
}

test('export: exports JSONL with decoded vector arrays to file', async () => {
  const dir = tempDir('export-jsonl');
  try {
    createSampleIndex(dir);
    const outFile = path.join(dir, 'out.jsonl');

    await cmdExport({
      db: dir,
      format: 'jsonl',
      output: outFile,
    });

    assert.ok(fs.existsSync(outFile));
    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const row0 = JSON.parse(lines[0]);
    assert.equal(row0.file, 'doc1.md');
    assert.equal(row0.title, 'Title');
    assert.equal(row0.heading, 'Intro');
    assert.deepEqual(row0.headingPath, ['Title', 'Intro']);
    assert.equal(row0.text, 'First chunk text');
    assert.ok(Array.isArray(row0.vec));
    assert.equal(row0.vec.length, 4);
    assert.ok(Math.abs(row0.vec[0] - 0.1) < 1e-5);
    assert.equal(row0.startLine, 1);
    assert.equal(row0.endLine, 10);
  } finally {
    safeRm(dir);
  }
});

test('export: exports JSONL with --no-vectors omitting vec field', async () => {
  const dir = tempDir('export-novectors');
  try {
    createSampleIndex(dir);
    const outFile = path.join(dir, 'out-no-vec.jsonl');

    await cmdExport({
      db: dir,
      format: 'jsonl',
      noVectors: true,
      output: outFile,
    });

    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const row0 = JSON.parse(lines[0]);
    assert.equal(row0.file, 'doc1.md');
    assert.equal(row0.vec, undefined);
  } finally {
    safeRm(dir);
  }
});

test('export: exports CSV with proper escaping for commas and newlines', async () => {
  const dir = tempDir('export-csv');
  try {
    createSampleIndex(dir);
    const outFile = path.join(dir, 'out.csv');

    await cmdExport({
      db: dir,
      format: 'csv',
      output: outFile,
    });

    const content = fs.readFileSync(outFile, 'utf8');
    assert.ok(content.startsWith('file,title,heading,headingPath,text\n'));
    assert.ok(content.includes('"Details, with ""quotes"""'));
    assert.ok(content.includes('"Second chunk\nwith newline"'));
  } finally {
    safeRm(dir);
  }
});

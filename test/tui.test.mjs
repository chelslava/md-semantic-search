import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTui } from '../dist/tui.js';
import { parseArgs } from '../bin/cli.mjs';

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test('runTui throws if process.stdin or process.stdout is not a TTY', async () => {
  await assert.rejects(
    async () => {
      await runTui({
        indexDir: './.mdss',
        cacheDir: './.cache',
      });
    },
    /interactive TUI requires a TTY terminal/
  );
});

test('cli parseArgs accepts rich search flags alongside --interactive and -i (issue #144)', () => {
  const opts1 = parseArgs(['search', '--interactive', '--db', './notes', '--filter', 'tag:backend AND status!=arch', '--since', '2026-01-01', '--tag', 'dev']);
  assert.equal(opts1.interactive, true);
  assert.equal(opts1.filter, 'tag:backend AND status!=arch');
  assert.equal(opts1.since, '2026-01-01');
  assert.equal(opts1.tag, 'dev');

  const opts2 = parseArgs(['search', '-i', '--db', './notes', '--project', 'mia', '--type', 'adr', '--status', 'accepted', '--graph-boost', '0.25']);
  assert.equal(opts2.interactive, true);
  assert.equal(opts2.project, 'mia');
  assert.equal(opts2.type, 'adr');
  assert.equal(opts2.status, 'accepted');
  assert.equal(opts2.graphBoost, 0.25);
});

test('runTui handles interactive sessions, filter DSL toggling (Ctrl+F), and invalid filters safely (issue #144)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-tui-'));
  const indexDir = path.join(root, '.mdss');
  const cacheDir = path.join(root, '.cache');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const fakeVec = Buffer.alloc(768 * 4).toString('base64');
  const fakeIndex = {
    schemaVersion: 3,
    format: 'binary-v1',
    db: root,
    model: 'Xenova/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 768,
    built: new Date().toISOString(),
    chunkCount: 1,
    lexical: { format: 'bm25-v1', documentLengths: [1], postings: { token: [[0, 1]] } },
    chunks: [
      { file: 'auth.md', title: 'Authentication', heading: 'Tokens', headingPath: ['Tokens'], text: 'JWT token auth implementation.', chunkHash: 'h1', vec: fakeVec },
    ],
  };
  const json = JSON.stringify(fakeIndex);
  fs.writeFileSync(path.join(indexDir, 'vectors.json'), json, 'utf8');
  const crypto = await import('node:crypto');
  const digest = crypto.createHash('sha256').update(json).digest('hex');
  fs.writeFileSync(path.join(indexDir, 'vectors.json.sha256'), `${digest}  vectors.json\n`, 'utf8');

  // Create fake TTY environment
  const origStdin = process.stdin;
  const origStdout = process.stdout;

  const fakeStdin = new EventEmitter();
  fakeStdin.isTTY = true;
  fakeStdin.isRaw = false;
  fakeStdin.setRawMode = () => {};
  fakeStdin.resume = () => {};
  fakeStdin.pause = () => {};

  let output = '';
  const fakeStdout = {
    isTTY: true,
    rows: 24,
    columns: 80,
    write: (chunk) => {
      output += String(chunk);
    },
    on: () => {},
    removeListener: () => {},
  };

  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });

  try {
    const tuiPromise = runTui({
      indexDir,
      cacheDir,
      db: root,
      query: 'token',
      filter: 'tag:security',
      since: '2026-01-01',
      tag: ['security'],
      debounceMs: 10,
      embedFn: async () => [new Float32Array(768)],
    });

    // Wait for initial render
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(output.includes('[F]ilter (Ctrl+F): tag:security'), 'filter line renders pre-set filter');
    assert.ok(output.includes('since: 2026-01-01'), 'filter line renders since constraint');
    assert.ok(output.includes('tag: security'), 'filter line renders tag constraint');

    // Press Ctrl+F to switch to filter editing
    fakeStdin.emit('keypress', '', { name: 'f', ctrl: true });
    await new Promise((r) => setTimeout(r, 20));

    // Type invalid filter chars
    fakeStdin.emit('keypress', '(', { name: undefined });
    fakeStdin.emit('keypress', '(', { name: undefined });
    await new Promise((r) => setTimeout(r, 50));

    // Must show inline error instead of crashing
    assert.ok(output.includes('[Err:'), 'inline error displayed for invalid filter');

    // Press escape to exit cleanly
    fakeStdin.emit('keypress', '', { name: 'escape' });
    const result = await tuiPromise;
    assert.equal(result, null, 'exited on escape cleanly');
  } finally {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
    safeRm(root);
  }
});


// ---------------------------------------------------------------------------
// issue #249: TUI ergonomics — editor-launch parity with `search --open`,
// wide-char (surrogate-pair) input, and the ?/F1 help overlay.
// ---------------------------------------------------------------------------

function buildTuiFixture(root) {
  const indexDir = path.join(root, '.mdss');
  const cacheDir = path.join(root, '.cache');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const fakeVec = Buffer.alloc(768 * 4).toString('base64');
  const fakeIndex = {
    schemaVersion: 3,
    format: 'binary-v1',
    db: root,
    model: 'Xenova/multilingual-e5-base@main',
    modelAlias: 'e5-base',
    dim: 768,
    built: new Date().toISOString(),
    chunkCount: 1,
    lexical: { format: 'bm25-v1', documentLengths: [1], postings: { token: [[0, 1]] } },
    chunks: [
      { file: 'auth.md', title: 'Authentication', heading: 'Tokens', headingPath: ['Tokens'], text: 'JWT token auth implementation.', startLine: 1, chunkHash: 'h1', vec: fakeVec },
    ],
  };
  const json = JSON.stringify(fakeIndex);
  fs.writeFileSync(path.join(indexDir, 'vectors.json'), json, 'utf8');
  return { indexDir, cacheDir, json };
}

async function withFakeTty(fn) {
  const origStdin = process.stdin;
  const origStdout = process.stdout;
  const fakeStdin = new EventEmitter();
  fakeStdin.isTTY = true;
  fakeStdin.isRaw = false;
  fakeStdin.setRawMode = () => {};
  fakeStdin.resume = () => {};
  fakeStdin.pause = () => {};
  let output = '';
  const fakeStdout = {
    isTTY: true,
    rows: 24,
    columns: 80,
    write: (chunk) => { output += String(chunk); },
    on: () => {},
    removeListener: () => {},
  };
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });
  try {
    return await fn(fakeStdin, () => output);
  } finally {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  }
}

test('tui: Enter routes through the shared opener (MDSS_EDITOR precedence, --goto) (issue #249)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-tui-open-'));
  const crypto = await import('node:crypto');
  try {
    const { indexDir, cacheDir, json } = buildTuiFixture(root);
    const digest = crypto.createHash('sha256').update(json).digest('hex');
    fs.writeFileSync(path.join(indexDir, 'vectors.json.sha256'), `${digest}  vectors.json
`, 'utf8');

    const launches = [];
    process.env.MDSS_EDITOR = 'code';
    try {
      await withFakeTty(async (fakeStdin) => {
        const tuiPromise = runTui({
          indexDir, cacheDir, db: root, query: 'token', debounceMs: 10,
          embedFn: async () => [new Float32Array(768)],
          // issue #249 test seam
          openRunner: (command, args) => launches.push({ command, args }),
        });
        await new Promise((r) => setTimeout(r, 50));
        fakeStdin.emit('keypress', '', { name: 'return' });
        await tuiPromise;
      });
    } finally {
      delete process.env.MDSS_EDITOR;
    }
    assert.equal(launches.length, 1, 'the shared opener ran once');
    assert.equal(launches[0].command, 'code');
    assert.deepEqual(launches[0].args, ['--goto', path.join(root, 'auth.md') + ':1'],
      'VS Code gets --goto with the chunk start line — identical to search --open');
  } finally {
    safeRm(root);
  }
});

test('tui: surrogate-pair and multi-unit input reaches the query line (issue #249)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-tui-wide-'));
  const crypto = await import('node:crypto');
  try {
    const { indexDir, cacheDir, json } = buildTuiFixture(root);
    const digest = crypto.createHash('sha256').update(json).digest('hex');
    fs.writeFileSync(path.join(indexDir, 'vectors.json.sha256'), `${digest}  vectors.json
`, 'utf8');

    await withFakeTty(async (fakeStdin, getOutput) => {
      const tuiPromise = runTui({
        indexDir, cacheDir, db: root, debounceMs: 10,
        embedFn: async () => [new Float32Array(768)],
      });
      await new Promise((r) => setTimeout(r, 50));
      // a CJK grapheme and an emoji surrogate pair — the old single-char
      // guard (length === 1) dropped the emoji entirely
      fakeStdin.emit('keypress', '日', { name: undefined });
      fakeStdin.emit('keypress', '😀', { name: undefined });
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(getOutput().includes('日'), 'CJK input lands in the query line');
      assert.ok(getOutput().includes('😀'), 'surrogate-pair emoji lands in the query line');
      fakeStdin.emit('keypress', '', { name: 'escape' });
      await tuiPromise;
    });
  } finally {
    safeRm(root);
  }
});

test('tui: ? toggles the help overlay when the query is empty (issue #249)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-tui-help-'));
  const crypto = await import('node:crypto');
  try {
    const { indexDir, cacheDir, json } = buildTuiFixture(root);
    const digest = crypto.createHash('sha256').update(json).digest('hex');
    fs.writeFileSync(path.join(indexDir, 'vectors.json.sha256'), `${digest}  vectors.json
`, 'utf8');

    await withFakeTty(async (fakeStdin, getOutput) => {
      const tuiPromise = runTui({
        indexDir, cacheDir, db: root, debounceMs: 10,
        embedFn: async () => [new Float32Array(768)],
      });
      await new Promise((r) => setTimeout(r, 50));
      fakeStdin.emit('keypress', '?', { name: undefined });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(getOutput().includes('key bindings'), 'the overlay renders');
      assert.ok(getOutput().includes('Ctrl+F'), 'it lists the bindings');
      fakeStdin.emit('keypress', '?', { name: undefined });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(getOutput().includes('Passage Preview'), 'a second ? returns to the search view');
      fakeStdin.emit('keypress', '', { name: 'escape' });
      await tuiPromise;
    });
  } finally {
    safeRm(root);
  }
});

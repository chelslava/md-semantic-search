// Alfred workflow tests (issue #230): pure helpers + the spawned Script
// Filter contract. Moved from integrations.test.mjs and extended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ALFRED_DIR = path.join(ROOT, 'integrations', 'alfred');

const {
  idleItem, noMatchesItem, errorItem, queryFromArgv, toAlfredItems,
} = await import(pathToFileURL(path.join(ALFRED_DIR, 'helpers.mjs')).href);

test('alfred helpers: idle/no-match/error items carry the Alfred schema (issue #230)', () => {
  const idle = idleItem();
  assert.equal(idle.items[0].valid, false);
  assert.ok(idle.items[0].subtitle.length > 0);

  const none = noMatchesItem('q "quoted"');
  assert.ok(none.items[0].subtitle.includes('q "quoted"'), 'query echoed in the subtitle');

  const err = errorItem('connect ECONNREFUSED');
  assert.ok(err.items[0].title.includes('Error'));
  assert.ok(err.items[0].subtitle.includes('mdss serve'), 'error names the serve prerequisite');
  assert.ok(err.items[0].subtitle.includes('ECONNREFUSED'), 'error detail surfaced');
});

test('alfred helpers: queryFromArgv joins argv words and trims (issue #230)', () => {
  assert.equal(queryFromArgv(['how', 'to', 'rotate']), 'how to rotate');
  assert.equal(queryFromArgv(['  spaced  ', 'out ']), 'spaced   out');
  assert.equal(queryFromArgv([]), '');
  assert.equal(queryFromArgv(undefined), '');
});

test('alfred helpers: toAlfredItems maps the daemon hit to the Script Filter item (issue #230)', () => {
  const items = toAlfredItems([
    { file: 'notes/api-tokens.md', title: 'API tokens', heading: 'Rotating', snippet: 'Rotate it before revoke.', cosine: 0.91234 },
    { file: 'notes/b.md', title: 'B', snippet: 'x', score: 0.5 }, // no heading, score fallback
  ]);
  assert.equal(items[0].uid, 'notes/api-tokens.md#Rotating');
  assert.equal(items[0].title, 'API tokens › Rotating');
  assert.match(items[0].subtitle, /\[cos: 0\.912\]/);
  assert.equal(items[0].arg, 'notes/api-tokens.md');
  assert.equal(items[0].quicklookurl, 'notes/api-tokens.md');
  assert.equal(items[0].text.copy, 'Rotate it before revoke.');
  assert.equal(items[1].uid, 'notes/b.md#', 'missing heading → empty anchor');
  assert.match(items[1].subtitle, /\[cos: 0\.500\]/, 'score falls back to r.score');
});

test('alfred: Script Filter spawns clean on empty query and daemon failure (issue #230)', () => {
  const scriptPath = path.join(ALFRED_DIR, 'search.mjs');
  assert.ok(fs.existsSync(scriptPath));

  const procEmpty = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(procEmpty.status, 0);
  const outEmpty = JSON.parse(procEmpty.stdout);
  assert.ok(Array.isArray(outEmpty.items));
  assert.equal(outEmpty.items[0].valid, false);

  const procQuery = spawnSync(process.execPath, [scriptPath, 'test query'], {
    encoding: 'utf8',
    env: { ...process.env, MDSS_DAEMON_URL: 'http://127.0.0.1:59999' },
  });
  assert.equal(procQuery.status, 0);
  const outQuery = JSON.parse(procQuery.stdout);
  assert.ok(Array.isArray(outQuery.items));
  assert.ok(outQuery.items[0].title.includes('Error'));
});

test('alfred: parity — the script reads MDSS_API_KEY through the shared client (issue #230)', () => {
  const src = fs.readFileSync(path.join(ALFRED_DIR, 'search.mjs'), 'utf8');
  assert.ok(src.includes('MDSS_API_KEY'), 'Bearer token env supported');
  assert.ok(src.includes('createSearchClient'), 'talks through the shared client');
  assert.ok(src.includes("MDSS_DAEMON_URL"), 'daemon URL env supported');
});

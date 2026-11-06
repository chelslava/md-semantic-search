// Raycast extension tests (issue #230): pure helpers + manifest parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAYCAST_DIR = path.join(ROOT, 'integrations', 'raycast');

const {
  buildSearchRequest, parseSearchResponse, toListItem, SEARCH_DEBOUNCE_MS,
} = await import(pathToFileURL(path.join(RAYCAST_DIR, 'src', 'helpers.mjs')).href);

test('raycast helpers: buildSearchRequest trims and defaults k (issue #230)', () => {
  assert.deepEqual(buildSearchRequest('  rotate token  '), { query: 'rotate token', k: 12 });
  assert.deepEqual(buildSearchRequest('x', { k: 3 }), { query: 'x', k: 3 });
  assert.deepEqual(buildSearchRequest(''), { query: '', k: 12 });
});

test('raycast helpers: parseSearchResponse accepts both daemon envelopes (issue #230)', () => {
  const hits = [{ file: 'a.md' }];
  assert.equal(parseSearchResponse({ results: hits }), hits, 'modern envelope');
  assert.equal(parseSearchResponse(hits), hits, 'legacy bare array');
  assert.deepEqual(parseSearchResponse(null), [], 'null → empty');
  assert.deepEqual(parseSearchResponse({}), [], 'unknown shape → empty');
});

test('raycast helpers: toListItem shapes the List.Item view model (issue #230)', () => {
  const vm = toListItem({
    file: 'notes/api-tokens.md', title: 'API tokens', heading: 'Rotating',
    snippet: 'Rotate before revoke.', cosine: 0.91234,
  });
  assert.equal(vm.key, 'notes/api-tokens.md-Rotating');
  assert.equal(vm.title, 'API tokens');
  assert.equal(vm.subtitle, 'Rotating');
  assert.equal(vm.accessory, 'cos: 0.912');
  assert.match(vm.markdown, /# API tokens/);
  assert.match(vm.markdown, /`notes\.api-tokens\.md`|`notes\/api-tokens\.md`/);
  assert.equal(vm.openTarget, 'notes/api-tokens.md');
  assert.equal(vm.snippet, 'Rotate before revoke.');

  const fallback = toListItem({ file: 'b.md', snippet: 's', score: 0.4 });
  assert.equal(fallback.title, 'b.md', 'missing title falls back to file');
  assert.equal(fallback.accessory, 'cos: 0.400', 'score fallback with 3 decimals');
});

test('raycast helpers: debounce constant is defined (issue #230)', () => {
  assert.equal(typeof SEARCH_DEBOUNCE_MS, 'number');
  assert.ok(SEARCH_DEBOUNCE_MS >= 100 && SEARCH_DEBOUNCE_MS <= 1000);
});

test('raycast: manifest declares the command and both daemon preferences (issue #230)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAYCAST_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'md-semantic-search');
  assert.ok(Array.isArray(pkg.commands));
  assert.equal(pkg.commands[0].name, 'search-notes');
  assert.equal(pkg.commands[0].mode, 'view');
  const prefs = pkg.preferences.map((p) => p.name);
  assert.ok(prefs.includes('daemonUrl'), 'daemon URL preference');
  assert.ok(prefs.includes('apiKey'), 'API key preference (Bearer parity, issue #230)');
  assert.equal(pkg.preferences.find((p) => p.name === 'apiKey').type, 'password', 'key input is masked');
});

test('raycast: command wires the helpers and the Bearer header (issue #230)', () => {
  const src = fs.readFileSync(path.join(RAYCAST_DIR, 'src', 'search-notes.tsx'), 'utf8');
  assert.ok(src.includes('buildSearchRequest'), 'request built via helpers');
  assert.ok(src.includes('parseSearchResponse'), 'response parsed via helpers');
  assert.ok(src.includes('Bearer'), 'Authorization header present');
  assert.ok(src.includes('preferences.apiKey'), 'apiKey preference consumed');
});

// ---------------------------------------------------------------------------
// issue #250: launcher parity — filter preferences map into the /search body,
// ask helpers shape the streamed /ask consumption.
// ---------------------------------------------------------------------------

test('raycast: buildSearchRequestWithFilters omits empty filter preferences (issue #250)', async () => {
  const { buildSearchRequestWithFilters } = await import('../integrations/raycast/src/helpers.mjs');
  assert.deepEqual(
    buildSearchRequestWithFilters('  rotate tokens ', { k: 7, tag: ' eng ', type: '', status: undefined }),
    { query: 'rotate tokens', k: 7, tag: 'eng' },
    'trimmed values kept, empty ones omitted',
  );
  assert.deepEqual(
    buildSearchRequestWithFilters('query', {}),
    { query: 'query', k: 12 },
    'no filters → identical to the plain body',
  );
});

test('raycast: renderAskDetail shapes the answer + sources markdown (issue #250)', async () => {
  const { renderAskDetail } = await import('../integrations/raycast/src/helpers.mjs');
  const md = renderAskDetail({
    answer: 'Tokens rotate every 90 days.',
    sources: [{ file: 'auth.md', heading: 'Tokens' }, { file: 'ops.md' }],
    mode: 'endpoint',
  });
  assert.ok(md.includes('Tokens rotate every 90 days.'));
  assert.ok(md.includes('**Sources**'));
  assert.ok(md.includes('`auth.md › Tokens`'));
  assert.ok(md.includes('_answer mode: endpoint_'));
  assert.equal(renderAskDetail({}), '', 'empty state renders nothing');
});

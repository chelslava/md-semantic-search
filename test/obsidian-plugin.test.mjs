import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  buildSearchRequest,
  buildRelatedRequest,
  formatHitHeading,
  formatLinkTarget,
  formatScore,
  formatRelatedReason,
  formatRelatedScore,
  buildErrorMessage,
  buildServeCommand,
  splitMatches,
  testConnection,
} from '../integrations/obsidian/helpers.mjs';

test('obsidian: default settings match standard daemon defaults (issue #136)', () => {
  assert.equal(DEFAULT_SETTINGS.host, '127.0.0.1');
  assert.equal(DEFAULT_SETTINGS.port, 8747);
  assert.equal(DEFAULT_SETTINGS.apiKey, '');
  assert.equal(DEFAULT_SETTINGS.k, 6);
  assert.equal(DEFAULT_SETTINGS.semanticOnly, false);
  assert.equal(DEFAULT_SETTINGS.rerank, false);
  assert.equal(DEFAULT_SETTINGS.ann, false);
});

test('obsidian: mergeSettings preserves defaults on empty or invalid input (issue #136)', () => {
  const mergedNull = mergeSettings(null);
  assert.deepEqual(mergedNull, DEFAULT_SETTINGS);

  const mergedEmpty = mergeSettings({});
  assert.deepEqual(mergedEmpty, DEFAULT_SETTINGS);

  const mergedInvalid = mergeSettings({
    port: 'invalid-port',
    k: -5,
    host: '   ',
  });
  assert.equal(mergedInvalid.port, 8747, 'bad port string falls back to default');
  assert.equal(mergedInvalid.k, 6, 'negative k falls back to default');
  assert.equal(mergedInvalid.host, '127.0.0.1', 'empty host falls back to default');
});

test('obsidian: mergeSettings preserves custom valid user configuration (issue #136)', () => {
  const custom = {
    host: '192.168.1.50',
    port: 9000,
    apiKey: 'my-secret-key',
    k: 15,
    semanticOnly: true,
    rerank: true,
    ann: true,
  };
  const merged = mergeSettings(custom);
  assert.deepEqual(merged, custom);

  // String port is coerced if valid number
  const stringPort = mergeSettings({ port: '8080' });
  assert.equal(stringPort.port, 8080);
});

test('obsidian: buildSearchRequest constructs correct url, headers, and body (issue #136)', () => {
  const req = buildSearchRequest(
    { host: 'localhost', port: 8747, apiKey: 'test-token', k: 8, semanticOnly: true },
    '  vector indexing architecture  '
  );

  assert.equal(req.url, 'http://localhost:8747/search');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['Authorization'], 'Bearer test-token');
  assert.deepEqual(req.body, {
    query: 'vector indexing architecture',
    k: 8,
    semanticOnly: true,
    rerank: false,
    ann: false,
  });

  // Without API key, no Authorization header
  const reqNoAuth = buildSearchRequest({ apiKey: '' }, 'hello');
  assert.equal(reqNoAuth.headers['Authorization'], undefined);
});

test('obsidian: buildSearchRequest body strictly adheres to /search API contract (issue #136)', () => {
  const { body } = buildSearchRequest({}, 'test query');
  const allowedKeys = new Set(['query', 'k', 'semanticOnly', 'rerank', 'ann']);
  for (const key of Object.keys(body)) {
    assert.ok(allowedKeys.has(key), `body property ${key} is valid in /search API schema`);
  }
  assert.equal(typeof body.query, 'string');
  assert.equal(typeof body.k, 'number');
  assert.equal(typeof body.semanticOnly, 'boolean');
  assert.equal(typeof body.rerank, 'boolean');
  assert.equal(typeof body.ann, 'boolean');
});

test('obsidian: formatHitHeading formats heading path correctly (issue #136)', () => {
  assert.equal(formatHitHeading({ file: 'docs/guide.md', heading: 'Installation' }), 'docs/guide.md › Installation');
  assert.equal(formatHitHeading({ file: 'docs/guide.md', heading: '' }), 'docs/guide.md');
  assert.equal(formatHitHeading({ file: 'docs/guide.md' }), 'docs/guide.md');
  assert.equal(formatHitHeading(null), '');
});

test('obsidian: formatLinkTarget formats Obsidian link target correctly (issue #136)', () => {
  assert.equal(formatLinkTarget({ file: 'docs/guide.md', heading: 'Installation' }), 'docs/guide.md#Installation');
  assert.equal(formatLinkTarget({ file: 'docs/guide.md', heading: '' }), 'docs/guide.md');
  assert.equal(formatLinkTarget({ file: 'docs/guide.md' }), 'docs/guide.md');
  assert.equal(formatLinkTarget(null), '');
});

test('obsidian: formatScore formats cosine similarity correctly (issue #136)', () => {
  assert.equal(formatScore({ cosine: 0.8523 }), '(cos: 0.85)');
  assert.equal(formatScore({ cosine: 1 }), '(cos: 1.00)');
  assert.equal(formatScore({ score: 0.72 }), '(cos: 0.72)');
  assert.equal(formatScore(null), '(cos: 0.00)');
});

test('obsidian: buildErrorMessage builds informative message with daemon coordinates (issue #136)', () => {
  const msg = buildErrorMessage(new Error('ECONNREFUSED'), { host: '127.0.0.1', port: 8747 });
  assert.ok(msg.includes('http://127.0.0.1:8747'));
  assert.ok(msg.includes('ECONNREFUSED'));
  assert.ok(msg.includes('mdss serve'));
});

test('obsidian: debounce timer pattern coalesces rapid inputs (issue #136)', async () => {
  let callCount = 0;
  let timer = null;

  function onInput() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      callCount++;
    }, 50);
  }

  // Simulate 5 rapid keystrokes within 20ms
  for (let i = 0; i < 5; i++) {
    onInput();
  }

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(callCount, 1, '5 rapid keystrokes coalesced into 1 search execution');

  // Test timer cleanup
  onInput();
  if (timer !== null) clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(callCount, 1, 'cleared timer prevented execution');
});

test('obsidian: splitMatches splits text safely for highlighting without HTML injection (issue #137)', () => {
  const text = 'Quick brown fox jumps over lazy dog.';
  const segs = splitMatches(text, ['fox', 'dog']);
  assert.deepEqual(segs, [
    { text: 'Quick brown ', isMatch: false },
    { text: 'fox', isMatch: true },
    { text: ' jumps over lazy ', isMatch: false },
    { text: 'dog', isMatch: true },
    { text: '.', isMatch: false },
  ]);

  // Case-insensitive & special regex chars
  const regexText = 'Vector (search) with [e5-base]* model.';
  const regexSegs = splitMatches(regexText, ['(search)', '[e5-base]*']);
  assert.deepEqual(regexSegs, [
    { text: 'Vector ', isMatch: false },
    { text: '(search)', isMatch: true },
    { text: ' with ', isMatch: false },
    { text: '[e5-base]*', isMatch: true },
    { text: ' model.', isMatch: false },
  ]);

  // XSS attack note payload remains plain text (never evaluated)
  const attackText = '<img src=x onerror=alert(1)> and regular text';
  const attackSegs = splitMatches(attackText, ['alert', 'regular']);
  assert.deepEqual(attackSegs, [
    { text: '<img src=x onerror=', isMatch: false },
    { text: 'alert', isMatch: true },
    { text: '(1)> and ', isMatch: false },
    { text: 'regular', isMatch: true },
    { text: ' text', isMatch: false },
  ]);

  // Empty matches returns single non-matching segment
  assert.deepEqual(splitMatches('hello world', []), [{ text: 'hello world', isMatch: false }]);
  assert.deepEqual(splitMatches('', ['test']), []);
});

test('obsidian: buildServeCommand constructs accurate copyable CLI commands (issue #137)', () => {
  assert.equal(buildServeCommand({}), 'mdss serve');
  assert.equal(buildServeCommand({}, 'C:\\My Vault'), 'mdss serve --db "C:\\My Vault"');
  assert.equal(
    buildServeCommand({ host: '0.0.0.0', port: 9000, apiKey: 'secret' }, '/vault'),
    'mdss serve --db "/vault" --host 0.0.0.0 --port 9000 --api-key-file <key-file>'
  );
});

test('obsidian: testConnection probes daemon and returns descriptive statuses (issue #137)', async () => {
  // Successful connection (200)
  const mockFetchOk = async (_url, _init) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, chunks: 128, model: 'multilingual-e5-base' }),
  });
  const resOk = await testConnection({ host: '127.0.0.1', port: 8747 }, mockFetchOk);
  assert.equal(resOk.ok, true);
  assert.equal(resOk.status, 200);
  assert.ok(resOk.message.includes('128 chunk(s) indexed'));
  assert.ok(resOk.message.includes('multilingual-e5-base'));

  // Unauthorized (401)
  const mockFetch401 = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
  });
  const res401 = await testConnection({ host: '127.0.0.1', port: 8747 }, mockFetch401);
  assert.equal(res401.ok, false);
  assert.equal(res401.status, 401);
  assert.ok(res401.message.includes('401'));

  // Connection refused / daemon down
  const mockFetchDown = async () => {
    throw new Error('fetch failed (ECONNREFUSED)');
  };
  const resDown = await testConnection({ host: '127.0.0.1', port: 8747 }, mockFetchDown);
  assert.equal(resDown.ok, false);
  assert.equal(resDown.status, 0);
  assert.ok(resDown.message.includes('ECONNREFUSED'));
  assert.ok(resDown.message.includes('mdss serve'));
});

test('obsidian: buildRelatedRequest constructs valid /related POST payload (issue #145)', () => {
  const req = buildRelatedRequest(
    { host: '127.0.0.1', port: 8747, apiKey: 'vault-secret', k: 10 },
    'Architecture/System Overview.md',
    { direction: 'both', semantic: true }
  );

  assert.equal(req.url, 'http://127.0.0.1:8747/related');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['Authorization'], 'Bearer vault-secret');
  assert.deepEqual(req.body, {
    file: 'Architecture/System Overview.md',
    k: 10,
    direction: 'both',
    semantic: true,
  });

  // Default options
  const defaultReq = buildRelatedRequest({}, 'note.md');
  assert.equal(defaultReq.body.file, 'note.md');
  assert.equal(defaultReq.body.k, 6);
  assert.equal(defaultReq.body.direction, 'both');
  assert.equal(defaultReq.body.semantic, true);
});

test('obsidian: formatRelatedReason and formatRelatedScore format human-readable output (issue #145)', () => {
  assert.equal(formatRelatedReason('outgoing link'), 'Outgoing link');
  assert.equal(formatRelatedReason('backlink'), 'Backlink');
  assert.equal(formatRelatedReason('bi-directional link'), 'Bi-directional link');
  assert.equal(formatRelatedReason('2-hop co-citation'), '2-hop co-citation');
  assert.equal(formatRelatedReason('semantic similarity'), 'Semantic similarity');
  assert.equal(formatRelatedReason(''), 'Related');
  assert.equal(formatRelatedReason(null), 'Related');

  assert.equal(formatRelatedScore({ score: 0.9321 }), '(score: 0.93)');
  assert.equal(formatRelatedScore({ score: 1 }), '(score: 1.00)');
  assert.equal(formatRelatedScore(null), '(score: 0.00)');
});

test('obsidian: active file change debounce pattern cancels stale in-flight requests (issue #145)', async () => {
  const executedFiles = [];
  let timer = null;
  let currentAbort = null;

  function onFileOpen(file) {
    if (timer !== null) clearTimeout(timer);
    if (currentAbort) currentAbort.aborted = true;

    const thisAbort = { aborted: false };
    currentAbort = thisAbort;

    timer = setTimeout(() => {
      if (!thisAbort.aborted) {
        executedFiles.push(file);
      }
    }, 40);
  }

  // Rapidly switch through 4 files within 20ms
  onFileOpen('note1.md');
  onFileOpen('note2.md');
  onFileOpen('note3.md');
  onFileOpen('final.md');

  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(executedFiles, ['final.md'], 'only the final active note triggered related-notes request');
});



import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assertSafePath, validateGlob } from '../dist/core.js';
import { deserializeBinaryIndex, BINARY_HEADER_SIZE } from '../dist/binary-format.js';
import { parseFilter, evaluateFilter, MAX_FILTER_DEPTH } from '../dist/filter.js';
import { handleStdioLine, MAX_STDIO_LINE_CHARS } from '../dist/mcp.js';

test('security: assertSafePath rejects all directory traversal and sandbox escape vectors', () => {
  const allowed = [process.cwd()];

  const dangerousPaths = [
    '../../../../etc/passwd',
    '..\\..\\..\\Windows\\System32\\calc.exe',
    '/etc/shadow',
    'C:\\sensitive\\passwords.txt',
    '\0/etc/hosts',
  ];

  for (const p of dangerousPaths) {
    assert.throws(
      () => assertSafePath(p, allowed),
      /path traversal|Forbidden path/i,
      `Failed to reject unsafe path: ${p}`
    );
  }
});

test('security: validateGlob rejects catastrophic backtracking patterns and regex injections', () => {
  const dangerousGlobs = [
    '((((a+)+)+)+)',
    'a{1,100000000}',
    'foo|bar',
    '$HOME/**',
    '$(whoami)',
  ];

  for (const g of dangerousGlobs) {
    assert.throws(
      () => validateGlob(g),
      /invalid glob pattern/i,
      `Failed to reject dangerous glob: ${g}`
    );
  }
});

test('security: deserializeBinaryIndex rejects truncated or corrupt binary buffers', () => {
  // Truncated header
  const shortBuf = Buffer.alloc(32);
  assert.throws(() => deserializeBinaryIndex(shortBuf), /file too small|too short/i);

  // Invalid magic bytes
  const badMagicBuf = Buffer.alloc(BINARY_HEADER_SIZE);
  badMagicBuf.write('XXXX');
  assert.throws(() => deserializeBinaryIndex(badMagicBuf), /magic/i);

  // Inconsistent vector length
  const corruptLengthBuf = Buffer.alloc(BINARY_HEADER_SIZE);
  corruptLengthBuf.write('MDSSBIN1', 0, 'utf8');
  corruptLengthBuf.writeUInt32LE(4, 8); // schemaVersion
  corruptLengthBuf.writeUInt32LE(100, 16); // 100 chunks claimed
  corruptLengthBuf.writeUInt32LE(384, 20); // dim 384
  corruptLengthBuf.writeUInt32LE(1000, 24); // 1000 vectorsByteLength claimed (too small for 100*384*4)
  assert.throws(() => deserializeBinaryIndex(corruptLengthBuf), /corrupt binary index|invalid binary index/i);
});

test('security: parseFilter safely handles deeply nested and malformed expressions without crashing', () => {
  const fuzzExpressions = [
    '((((((((((((((((((((((tag:a))))))))))))))))))))))',
    'tag:a AND (status == 1 OR (',
    'tag:"unclosed string',
    'tag:!@#$%^&*()',
    'status > 99999999999999999999999999999999999',
    'AND AND OR NOT',
  ];

  for (const expr of fuzzExpressions) {
    try {
      const ast = parseFilter(expr);
      // Evaluation should be deterministic
      evaluateFilter(ast, { tags: ['a'], status: 'active' });
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  }
});

test('security: filter DSL caps parser recursion depth with a clear error (issue #180)', () => {
  // 50k nesting levels used to be a RangeError halfway through the sweep slot
  const bomb = '('.repeat(50_000) + 'tag:a' + ')'.repeat(50_000);
  assert.throws(() => parseFilter(bomb), /too deeply nested/);
  assert.throws(() => parseFilter(bomb), (err) => !(err instanceof RangeError));

  // boundary sanity: nesting exactly at the cap parses into a single comparison
  const atCap = '('.repeat(MAX_FILTER_DEPTH) + 'tag:a' + ')'.repeat(MAX_FILTER_DEPTH);
  const ast = parseFilter(atCap);
  assert.equal(ast.type, 'COMPARE');
  assert.equal(ast.field, 'tag');
});

/** Temporarily capture what the handler writes to stdout. */
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const fakeState = { loaded: { index: { chunks: [] }, model: { id: 'dummy', dim: 8 } }, cacheDir: '', offline: true };

test('security: handleStdioLine refuses oversized lines without parsing (issue #180)', async () => {
  const responses = await captureStdout(() =>
    handleStdioLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}' + ' '.repeat(MAX_STDIO_LINE_CHARS + 10), fakeState)
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, -32600);
  assert.match(responses[0].error.message, /too large/);
});

test('security: handleStdioLine answers -32700 for invalid JSON and keeps the process alive (issue #180)', async () => {
  const responses = await captureStdout(() => handleStdioLine('{ definitely not json', fakeState));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, -32700);
});

test('security: handleStdioLine converts handler escapes into -32603 instead of crashing (issue #185)', async () => {
  // resources/list reads state.loaded outside any per-method try/catch — a
  // poisoned state turns that into an internal-error response, not a rejection
  const poison = {
    get loaded() {
      throw new Error('boom');
    },
    cacheDir: '',
    offline: true,
  };
  const responses = await captureStdout(() =>
    handleStdioLine('{"jsonrpc":"2.0","id":7,"method":"resources/list"}', poison)
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 7);
  assert.equal(responses[0].error.code, -32603);
  assert.match(responses[0].error.message, /boom/);
});

test('security: handleStdioLine still answers valid requests normally (issue #185)', async () => {
  const responses = await captureStdout(() =>
    handleStdioLine('{"jsonrpc":"2.0","id":3,"method":"tools/list"}', fakeState)
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error, undefined);
  assert.ok(Array.isArray(responses[0].result.tools));
});

test('security: real stdio loop survives oversized lines and answers in order (issue #180/#185)', async () => {
  const repo = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-stdio-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'a.md'),
      '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n'
    );
    const childScript = path.join(dir, 'stdio-child.mjs');
    const dist = (m) => pathToFileURL(path.join(repo, 'dist', m)).href;
    fs.writeFileSync(
      childScript,
      `import path from 'node:path';
import { buildIndex } from ${JSON.stringify(dist('indexer.js'))};
import { startMcpServer } from ${JSON.stringify(dist('mcp.js'))};
function fakeEmbed(texts, kind, model) {
  return texts.map((t) => {
    const dim = model?.dim > 0 ? model.dim : 8;
    const v = new Array(dim).fill(0);
    const words = t.toLowerCase().match(/[\\p{L}\\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}
const dir = process.argv[2];
await startMcpServer({
  indexDir: path.join(dir, '.mdss'),
  cacheDir: dir,
  db: dir,
  modelName: 'e5-base',
  offline: true,
  embedFn: fakeEmbed,
});
`
    );

    const hugeLine = 'x'.repeat(2 * 1024 * 1024);
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      hugeLine,
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      '',
    ].join('\n');

    const r = spawnSync(process.execPath, [childScript, dir], { input, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `child exited cleanly, stderr: ${r.stderr?.slice(0, 400)}`);
    const lines = r.stdout.split('\n').filter((l) => l.trim());
    const responses = lines.map((l) => JSON.parse(l));
    assert.equal(responses.length, 3, `expected 3 responses, got ${responses.length}`);
    assert.equal(responses[0].id, 1);
    assert.ok(Array.isArray(responses[0].result.tools));
    assert.equal(responses[1].error.code, -32600, 'oversized line rejected in-band');
    assert.equal(responses[2].id, 2, 'responses stay in request order after the rejection');
    assert.ok(Array.isArray(responses[2].result.tools));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafePath, validateGlob } from '../dist/core.js';
import { deserializeBinaryIndex, BINARY_HEADER_SIZE } from '../dist/binary-format.js';
import { parseFilter, evaluateFilter } from '../dist/filter.js';

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

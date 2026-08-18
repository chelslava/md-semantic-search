import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeFilter, parseFilter, evaluateFilter } from '../dist/filter.js';

test('tokenizeFilter: splits operators, words, and quoted strings', () => {
  const tokens = tokenizeFilter('tag:engineering AND (status != "archived" OR priority >= 2)');
  assert.deepEqual(tokens, [
    'tag', ':', 'engineering',
    'AND', '(',
    'status', '!=', '"archived"',
    'OR',
    'priority', '>=', '2',
    ')',
  ]);
});

test('parseFilter: builds correct boolean AST with operator precedence and grouping', () => {
  const ast = parseFilter('tag:engineering AND (status != archived OR priority >= 2)');
  assert.equal(ast.type, 'AND');
  assert.equal(ast.left.type, 'COMPARE');
  assert.equal(ast.left.field, 'tag');
  assert.equal(ast.left.op, ':');
  assert.equal(ast.left.value, 'engineering');

  assert.equal(ast.right.type, 'OR');
  assert.equal(ast.right.left.type, 'COMPARE');
  assert.equal(ast.right.left.field, 'status');
  assert.equal(ast.right.left.op, '!=');
  assert.equal(ast.right.left.value, 'archived');

  assert.equal(ast.right.right.type, 'COMPARE');
  assert.equal(ast.right.right.field, 'priority');
  assert.equal(ast.right.right.op, '>=');
  assert.equal(ast.right.right.value, 2);
});

test('evaluateFilter: evaluates tag inclusion and status filter', () => {
  const meta = {
    tags: ['engineering', 'backend'],
    status: 'active',
    aliases: [],
    custom: { priority: 3 },
  };

  assert.equal(evaluateFilter('tag:engineering AND status = active', meta), true);
  assert.equal(evaluateFilter('tag:frontend AND status = active', meta), false);
  assert.equal(evaluateFilter('tag:engineering AND status != archived', meta), true);
  assert.equal(evaluateFilter('tag:engineering AND (status = draft OR status = active)', meta), true);
  assert.equal(evaluateFilter('priority >= 2', meta), true);
  assert.equal(evaluateFilter('priority < 2', meta), false);
});

test('evaluateFilter: handles NOT operator and date comparisons', () => {
  const meta = {
    tags: ['rfc'],
    created: '2026-05-01',
    aliases: [],
    custom: {},
  };

  assert.equal(evaluateFilter('NOT tag:draft', meta), true);
  assert.equal(evaluateFilter('date >= 2026-01-01', meta), true);
  assert.equal(evaluateFilter('date < 2026-01-01', meta), false);
});

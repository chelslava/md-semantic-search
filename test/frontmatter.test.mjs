import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../dist/frontmatter.js';

test('parseFrontmatter handles scalar strings, numbers, booleans, dates', () => {
  const yaml = `
title: "Semantic Search Guide"
project: kb-core
type: guide
status: active
canonical: true
created: 2026-08-01
updated: 2026-08-16
`;

  const meta = parseFrontmatter(yaml);
  assert.equal(meta.title, 'Semantic Search Guide');
  assert.equal(meta.project, 'kb-core');
  assert.equal(meta.type, 'guide');
  assert.equal(meta.status, 'active');
  assert.equal(meta.canonical, true);
  assert.equal(meta.created, '2026-08-01');
  assert.equal(meta.updated, '2026-08-16');
});

test('parseFrontmatter handles inline and block list tags and aliases', () => {
  const yaml = `
tags: [#search, #vector, indexing]
aliases:
  - "Search Doc"
  - Vector search
canonical_ref: "[[CanonicalTarget]]"
`;

  const meta = parseFrontmatter(yaml);
  assert.deepEqual(meta.tags, ['search', 'vector', 'indexing']);
  assert.deepEqual(meta.aliases, ['Search Doc', 'Vector search']);
  assert.equal(meta.canonicalRef, 'CanonicalTarget');
});

test('parseFrontmatter normalizes comma-separated tags and custom attributes', () => {
  const yaml = `
tags: #AI, #ML, #knowledge-base
author: Vyacheslav
priority: 1
`;

  const meta = parseFrontmatter(yaml);
  assert.deepEqual(meta.tags, ['ai', 'ml', 'knowledge-base']);
  assert.equal(meta.custom['author'], 'Vyacheslav');
  assert.equal(meta.custom['priority'], 1);
});

test('parseFrontmatter handles empty or malformed frontmatter gracefully', () => {
  assert.deepEqual(parseFrontmatter(''), { aliases: [], tags: [], custom: {} });
  assert.deepEqual(parseFrontmatter(null), { aliases: [], tags: [], custom: {} });
});

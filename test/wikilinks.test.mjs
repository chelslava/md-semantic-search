import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, resolveLinks, buildRelationshipGraph, getRelatedNotes } from '../src/wikilinks.mjs';

test('extractLinks parses Obsidian wikilinks and relative Markdown links', () => {
  const markdown = `
# Sample Note
Check out [[Architecture]] and [[System Design#Overview|Design]].
Also see [User Guide](./user-guide.md#setup) for details.
  `;

  const links = extractLinks(markdown);
  assert.equal(links.length, 3);
  assert.equal(links[0].target, 'Architecture');
  assert.equal(links[1].target, 'System Design');
  assert.equal(links[1].anchor, 'Overview');
  assert.equal(links[1].label, 'Design');
  assert.equal(links[2].type, 'markdown');
  assert.equal(links[2].target, './user-guide.md');
});

test('resolveLinks resolves targets against file names, titles, and aliases', () => {
  const docs = [
    { file: 'arch.md', title: 'Architecture' },
    { file: 'design.md', title: 'System', meta: { aliases: ['System Design'] } },
    { file: 'guide.md', title: 'User Guide' },
  ];

  const rawLinks = [
    { type: 'wikilink', target: 'Architecture', raw: '[[Architecture]]', line: 1 },
    { type: 'wikilink', target: 'System Design', raw: '[[System Design]]', line: 2 },
    { type: 'wikilink', target: 'Missing Note', raw: '[[Missing Note]]', line: 3 },
  ];

  const resolved = resolveLinks(rawLinks, 'index.md', docs);
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].status, 'resolved');
  assert.equal(resolved[0].resolvedFile, 'arch.md');
  assert.equal(resolved[1].status, 'resolved');
  assert.equal(resolved[1].resolvedFile, 'design.md');
  assert.equal(resolved[2].status, 'broken');
});

test('buildRelationshipGraph & getRelatedNotes builds outgoing links and backlinks', () => {
  const docs = [
    { file: 'a.md', text: 'See [[b.md]]' },
    { file: 'b.md', text: 'See [[c.md]]' },
    { file: 'c.md', text: 'End of chain' },
  ];

  const graph = buildRelationshipGraph(docs);

  const relatedA = getRelatedNotes(graph, 'a.md', { direction: 'outgoing', depth: 2 });
  assert.equal(relatedA.length, 2);
  assert.equal(relatedA[0].file, 'b.md');
  assert.equal(relatedA[1].file, 'c.md');

  const backC = getRelatedNotes(graph, 'c.md', { direction: 'backlinks', depth: 1 });
  assert.equal(backC.length, 1);
  assert.equal(backC[0].file, 'b.md');
});

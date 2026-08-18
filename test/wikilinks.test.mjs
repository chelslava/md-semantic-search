import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLinks,
  resolveLinks,
  buildRelationshipGraph,
  getRelatedNotes,
  computePageRank,
  expandGraphNeighborhood,
} from '../dist/wikilinks.js';

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

test('computePageRank handles single node, hub/star graph, and cyclic links', () => {
  // 1. Single node
  const singleGraph = buildRelationshipGraph([{ file: 'solo.md', text: 'no links' }]);
  const singlePR = computePageRank(singleGraph);
  assert.equal(singlePR.get('solo.md'), 1.0);

  // 2. Star graph: a, b, c all link to hub.md; hub links to none
  const starDocs = [
    { file: 'a.md', text: 'See [[hub.md]]' },
    { file: 'b.md', text: 'See [[hub.md]]' },
    { file: 'c.md', text: 'See [[hub.md]]' },
    { file: 'hub.md', text: 'I am the hub' },
  ];
  const starGraph = buildRelationshipGraph(starDocs);
  const starPR = computePageRank(starGraph);

  assert.ok(starPR.get('hub.md') > starPR.get('a.md'));
  assert.ok(starPR.get('hub.md') > starPR.get('b.md'));
  assert.ok(starPR.get('hub.md') > starPR.get('c.md'));

  // Sum of PageRanks should be approximately 1.0
  let starSum = 0;
  for (const val of starPR.values()) starSum += val;
  assert.ok(Math.abs(starSum - 1.0) < 1e-4);

  // 3. Cyclic graph: A <-> B
  const cyclicDocs = [
    { file: 'x.md', text: 'See [[y.md]]' },
    { file: 'y.md', text: 'See [[x.md]]' },
  ];
  const cyclicGraph = buildRelationshipGraph(cyclicDocs);
  const cyclicPR = computePageRank(cyclicGraph);
  assert.ok(Math.abs(cyclicPR.get('x.md') - cyclicPR.get('y.md')) < 1e-4);
});

test('expandGraphNeighborhood propagates relevance with decay over 2 hops', () => {
  const docs = [
    { file: 'seed.md', text: 'See [[hop1.md]]' },
    { file: 'hop1.md', text: 'See [[hop2.md]]' },
    { file: 'hop2.md', text: 'See [[hop3.md]]' },
    { file: 'hop3.md', text: 'Far away' },
  ];
  const graph = buildRelationshipGraph(docs);

  const seeds = [{ file: 'seed.md', score: 1.0 }];
  const propagated = expandGraphNeighborhood(graph, seeds, { maxDepth: 2, decay: 0.5 });

  // 1-hop should receive 1.0 * 0.5 = 0.5
  assert.equal(propagated.get('hop1.md'), 0.5);
  // 2-hop should receive 1.0 * (0.5^2) = 0.25
  assert.equal(propagated.get('hop2.md'), 0.25);
  // 3-hop is beyond maxDepth 2
  assert.equal(propagated.has('hop3.md'), false);
});


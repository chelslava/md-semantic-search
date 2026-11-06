import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function safeRm(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
}
import {
  extractLinks,
  resolveLinks,
  buildRelationshipGraph,
  getRelatedNotes,
  computePageRank,
  expandGraphNeighborhood,
  findRelatedNotes,
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

test('findRelatedNotes finds backlinks, outgoing links, 2-hop and semantic relations (issue #141)', () => {
  const loaded = {
    index: {
      chunks: [
        {
          file: 'ideas.md',
          title: 'Project Ideas',
          text: 'We explore new concepts. See [[Architecture]] and [[Database]].',
          vec: [1, 0, 0, 0],
        },
        {
          file: 'arch.md',
          title: 'Architecture',
          text: 'Core architecture overview. Backlinks to [[ideas.md]]. Also references [[deployment.md]].',
          vec: [0.9, 0.1, 0, 0],
        },
        {
          file: 'db.md',
          title: 'Database',
          text: 'Database schema and tables.',
          vec: [0, 1, 0, 0],
        },
        {
          file: 'deployment.md',
          title: 'Deployment',
          text: 'Production Kubernetes and Docker setup.',
          vec: [0, 0, 1, 0],
        },
        {
          file: 'unlinked-concept.md',
          title: 'Unlinked Idea',
          text: 'Conceptual project thoughts without direct links.',
          vec: [0.95, 0.05, 0, 0],
        },
      ],
    },
  };

  // 1. Query for "ideas.md"
  const rel = findRelatedNotes({ loaded, target: 'ideas.md', k: 5, semantic: true });
  assert.equal(rel.resolvedFile, 'ideas.md');
  assert.ok(rel.results.length >= 3);

  // Architecture is bi-directional (ideas -> arch and arch -> ideas)
  const archHit = rel.results.find((r) => r.file === 'arch.md');
  assert.ok(archHit);
  assert.ok(archHit.reason.includes('bi-directional'));

  // Database is outgoing (ideas -> db)
  const dbHit = rel.results.find((r) => r.file === 'db.md');
  assert.ok(dbHit);
  assert.ok(dbHit.reason.includes('outgoing'));

  // Deployment is 2-hop (ideas -> arch -> deployment)
  const deployHit = rel.results.find((r) => r.file === 'deployment.md');
  assert.ok(deployHit);
  assert.ok(deployHit.reason.includes('2-hop'));

  // unlinked-concept has high cosine similarity (0.95 vs [1,0,0,0])
  const unlinkedHit = rel.results.find((r) => r.file === 'unlinked-concept.md');
  assert.ok(unlinkedHit);
  assert.ok(unlinkedHit.reason.includes('semantic'));

  // 2. Note lookup by title
  const relTitle = findRelatedNotes({ loaded, target: 'Architecture', k: 5 });
  assert.equal(relTitle.resolvedFile, 'arch.md');

  // 3. Unknown note throws clear error
  assert.throws(() => findRelatedNotes({ loaded, target: 'NonExistent' }), /Note not found/);
});



test('related: findRelatedNotes caches the per-generation runtime — identical results, no rebuild (issue #246)', async () => {
  const { buildIndex } = await import('../dist/indexer.js');
  const { loadIndex } = await import('../dist/search.js');

  function fakeEmbed(texts, kind, model) {
    return texts.map((t) => {
      const dim = model?.dim > 0 ? model.dim : 8;
      const v = new Array(dim).fill(0);
      const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      for (const w of words) {
        let h = 7;
        for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
        v[h % dim] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-relcache-'));
  const idx = path.join(dir, '.mdss');
  try {
    for (let f = 0; f < 12; f++) {
      let md = `# Doc ${f}\n\n## Topic ${f % 3}\n\nDocument ${f} discusses topic ${f % 3} with enough body text.\n`;
      for (let l = 1; l <= 2; l++) md += `See [[Doc ${(f + l) % 12}]] for more.\n`;
      fs.writeFileSync(path.join(dir, `doc${f}.md`), md);
    }
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const loaded = loadIndex(idx);

    const a = findRelatedNotes({ loaded, target: 'doc0.md', k: 10 });
    const b = findRelatedNotes({ loaded, target: 'doc0.md', k: 10 });
    const c = findRelatedNotes({ loaded, target: 'Doc 0', k: 10 }); // alias-style target
    const key = (r) => JSON.stringify(r.results.map((h) => [h.file, h.score, h.reason, h.distance]));
    assert.equal(key(a), key(b), 'second call is served from the per-generation cache, rank for rank');
    assert.equal(key(a), key(c), 'target resolution unchanged');

    // a swapped index generation (new loadIndex) must not reuse the old cache
    const reloaded = loadIndex(idx);
    const d = findRelatedNotes({ loaded: reloaded, target: 'doc0.md', k: 10 });
    assert.equal(key(a), key(d), 'new generation produces the same results independently');
  } finally {
    safeRm(dir);
  }
});

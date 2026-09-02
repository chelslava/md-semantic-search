import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseResults } from '../dist/collapse.js';

test('collapseResults limits items per document key', () => {
  const hits = [
    { file: 'doc1.md', score: 0.9, text: 'chunk 1' },
    { file: 'doc1.md', score: 0.8, text: 'chunk 2' },
    { file: 'doc2.md', score: 0.75, text: 'chunk 3' },
    { file: 'doc1.md', score: 0.7, text: 'chunk 4' },
    { file: 'doc2.md', score: 0.65, text: 'chunk 5' },
  ];

  const collapsed1 = collapseResults(hits, h => h.file, 1);
  assert.equal(collapsed1.length, 2);
  assert.equal(collapsed1[0].file, 'doc1.md');
  assert.equal(collapsed1[1].file, 'doc2.md');

  const collapsed2 = collapseResults(hits, h => h.file, 2);
  assert.equal(collapsed2.length, 4);
  assert.equal(collapsed2.filter(h => h.file === 'doc1.md').length, 2);
  assert.equal(collapsed2.filter(h => h.file === 'doc2.md').length, 2);
});

test('collapseResults respects canonical metadata over file path when present', () => {
  const hits = [
    { file: 'v1.md', score: 0.9, meta: { canonical: 'doc-canonical' } },
    { file: 'v2.md', score: 0.85, meta: { canonical: 'doc-canonical' } },
    { file: 'other.md', score: 0.8 },
  ];

  const collapsed = collapseResults(hits, h => h.meta?.canonical || h.file, 1);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].file, 'v1.md');
  assert.equal(collapsed[1].file, 'other.md');
});

test('searchIndex: expands candidate pool under maxPerFile to prevent result starvation (issue #150)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { buildIndex } = await import('../dist/indexer.js');
  const { loadIndex, searchIndex } = await import('../dist/search.js');

  function fakeEmbed(texts, kind, model) {
    return texts.map((t) => {
      const dim = model?.dim > 0 ? model.dim : 768;
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-collapse-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(db, 'doc1.md'),
      '# Quantum\n\n## Section 1\nQuantum computing algorithms demonstrate quadratic speedup for unstructured database search.\n\n## Section 2\nQuantum computing algorithms utilize phase estimation for order finding routines.\n\n## Section 3\nQuantum computing algorithms apply fault tolerant stabilizer codes for error correction.\n\n## Section 4\nQuantum computing algorithms prepare entangled Bell states for teleportation protocols.\n\n## Section 5\nQuantum computing algorithms optimize variational quantum eigensolvers for chemistry simulation.\n\n## Section 6\nQuantum computing algorithms execute quantum approximate optimization for combinatorial graphs.\n'
    );
    fs.writeFileSync(path.join(db, 'doc2.md'), '# Doc2\n\nQuantum computing algorithms enhance discrete logarithm factorization routines.\n');
    fs.writeFileSync(path.join(db, 'doc3.md'), '# Doc3\n\nQuantum computing algorithms provide exponential speedup for linear systems simulation.\n');
    fs.writeFileSync(path.join(db, 'doc4.md'), '# Doc4\n\nQuantum computing algorithms analyze topological quantum field theories.\n');
    fs.writeFileSync(path.join(db, 'doc5.md'), '# Doc5\n\nQuantum computing algorithms benchmark randomized benchmarking gate fidelities.\n');
    fs.writeFileSync(path.join(db, 'doc6.md'), '# Doc6\n\nQuantum computing algorithms implement lattice surgery on surface code patches.\n');

    await buildIndex({
      db,
      indexDir,
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const loaded = loadIndex(indexDir);

    const results = await searchIndex({
      loaded,
      cacheDir: root,
      query: 'quantum computing',
      k: 5,
      maxPerFile: 1,
      embedFn: fakeEmbed,
    });

    assert.equal(results.length, 5);
    const distinctFiles = new Set(results.map((r) => r.file));
    assert.equal(distinctFiles.size, 5);
    assert.ok(distinctFiles.has('doc1.md'));
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});


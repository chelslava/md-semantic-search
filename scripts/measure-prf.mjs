/**
 * One-off measurement for issue #125 acceptance:
 * Recall@10 / nDCG@10 baseline vs `expand:'prf'` on the frozen golden
 * fixture (dev slice), network-free fake embedder — same shapes as
 * scripts/run-bench.mjs.
 *
 *   node scripts/measure-prf.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from '../bench/fixture.mjs';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex } from '../dist/search.js';
import { queryMetrics, aggregateMetrics } from '../dist/metrics.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = loadFixture(JSON.parse(fs.readFileSync(path.join(REPO, 'bench/fixtures/dev-golden.json'), 'utf8')));

function fakeEmbed(texts, kind, model, _cacheDir) {
  const dim = model?.dim > 0 ? model.dim : 384;
  return texts.map((t) => {
    const v = new Array(dim).fill(0);
    const words = String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const pref = kind === 'query' ? 'query' : '';
    for (const w of [pref, ...words].filter(Boolean)) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

async function main() {
  const db = path.resolve(REPO, fixture.corpusPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-prf-measure-'));
  const indexDir = path.join(tmp, '.mdss');

  await buildIndex({
    db,
    indexDir,
    cacheDir: path.join(tmp, '.cache'),
    modelName: 'e5-base',
    embedFn: fakeEmbed,
    offline: true,
  });
  const loaded = loadIndex(indexDir);

  const ids = fixture.slices.dev ?? [];
  const queries = fixture.queries.filter((q) => ids.includes(q.id));

  async function run(expand) {
    const perQuery = [];
    for (const q of queries) {
      const hits = await searchIndex({
        loaded,
        cacheDir: path.join(tmp, '.cache'),
        query: q.text,
        k: 10,
        embedFn: fakeEmbed,
        offline: true,
        ...(expand ? { expand, expandPassages: 3 } : {}),
      });
      const ranked = [...new Set(hits.map((h) => h.file))];
      const docGrades = {};
      for (const qr of q.qrels) docGrades[qr.doc] = qr.grade;
      const qm = queryMetrics(ranked, docGrades, { k: 10, allRelevant: Object.keys(docGrades) });
      perQuery.push(qm);
    }
    return aggregateMetrics(perQuery).mean;
  }

  const base = await run(null);
  const prf = await run('prf');

  console.log(`queries: ${queries.length} · k=10 · fake embedder`);
  console.log('Recall@10 :', base.recall.toFixed(4), '→', prf.recall.toFixed(4));
  console.log('nDCG@10   :', base.ndcg.toFixed(4), '→', prf.ndcg.toFixed(4));
  console.log('MRR@10    :', base.mrr.toFixed(4), '→', prf.mrr.toFixed(4));

  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

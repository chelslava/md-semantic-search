#!/usr/bin/env node
// @ts-check
/**
 * Golden-set benchmark runner (issue #56).
 *
 * Loads a golden fixture (schema v1, see bench/fixture.mjs), builds the index
 * over the frozen corpus, runs every query of the selected slice through
 * searchIndex, and reports retrieval metrics (nDCG@k, MRR, Hit@k, Recall@k).
 *
 * Usage:
 *   node scripts/run-bench.mjs [--fixture bench/fixtures/dev-golden.json]
 *                              [--slice dev|test|holdout] [--k 10]
 *                              [--model e5-base]
 *                              [--index-dir <path>] [--cache-dir <path>]
 *                              [--fast] [--json] [--fake]
 *
 * --fast      smoke mode: k=3, tiny candidate pool — for CI, not for real eval.
 * --fake      deterministic hash embedder (no model download, fully offline) —
 *             for CI smoke; numbers are NOT comparable to real-model eval.
 * --json      machine-readable report (name, model, slice, k, corpusHash, mean).
 *
 * Exit codes: 0 = ran, 1 = fixture/corpus error, 2 = usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadFixture, corpusFingerprint } from '../bench/fixture.mjs';
import { queryMetrics, aggregateMetrics } from '../dist/metrics.js';
import { buildIndex, loadIndex, searchIndex } from '../dist/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

/** @param {string} dir @returns {Array<{path:string, hash:string}>} */
function walkCorpus(dir) {
  /** @type {Array<{path:string, hash:string}>} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.mdss') continue;
        walk(abs);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        const rel = path.relative(dir, abs).split(path.sep).join('/');
        out.push({ path: rel, hash: sha256(fs.readFileSync(abs)) });
      }
    }
  };
  walk(dir);
  return out;
}

/** @param {Buffer|string} data @returns {string} */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string[]} argv
 * @returns {{fixture:string, slice:string, k:number, model:string, indexDir:string|null, cacheDir:string|null, json:boolean, fast:boolean, fake:boolean}}
 */
function parseArgs(argv) {
  const args = {
    fixture: path.join(REPO, 'bench/fixtures/dev-golden.json'),
    slice: 'dev', k: 10, model: 'e5-base',
    indexDir: null, cacheDir: null, json: false, fast: false, fake: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--fixture') args.fixture = next();
    else if (a === '--slice') args.slice = next();
    else if (a === '--k') args.k = Number(next());
    else if (a === '--model') args.model = next();
    else if (a === '--index-dir') args.indexDir = next();
    else if (a === '--cache-dir') args.cacheDir = next();
    else if (a === '--json') args.json = true;
    else if (a === '--fast') args.fast = true;
    else if (a === '--fake') args.fake = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

/** Deterministic fake embedder (no model, no network) for CI smoke runs. */
function fakeEmbed(texts, kind, model, cacheDir) {
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

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err.message}`);
    process.exit(2);
  }

  let fixture;
  try {
    fixture = loadFixture(JSON.parse(fs.readFileSync(args.fixture, 'utf8')));
  } catch (err) {
    console.error(`fixture error: ${err.message}`);
    process.exit(1);
  }

  const db = path.resolve(REPO, fixture.corpusPath);
  if (!fs.existsSync(db)) {
    console.error(`corpus not found: ${db} (fixture.corpusPath = ${fixture.corpusPath})`);
    process.exit(1);
  }
  const indexDir = args.indexDir ? path.resolve(REPO, args.indexDir) : path.join(db, '.mdss');
  const cacheDir = args.cacheDir ?? undefined;
  const k = args.fast ? Math.min(3, args.k) : args.k;

  const ids = fixture.slices[/** @type {keyof typeof fixture.slices} */ (args.slice)] ?? [];
  if (ids.length === 0) {
    console.error(`slice "${args.slice}" is empty`);
    process.exit(2);
  }
  const queries = fixture.queries.filter((q) => ids.includes(q.id));

  const corpusHash = corpusFingerprint(walkCorpus(db));
  if (fixture.corpusHash && fixture.corpusHash !== corpusHash) {
    console.error(
      `corpus fingerprint mismatch: fixture says ${fixture.corpusHash}, actual ${corpusHash} ` +
      `— the frozen corpus changed; freeze it or update the fixture`);
    process.exit(1);
  }

  const embedFn = args.fake ? fakeEmbed : undefined;
  const offline = args.fake;
  const build = await buildIndex({ db, indexDir, cacheDir, modelName: args.model, embedFn, offline });
  const loaded = loadIndex(indexDir);

  /** @type {Array<{id:string, category:string, language:string, ndcg:number, mrr:number, hit:0|1, recall:number}>} */
  const perQuery = [];
  for (const q of queries) {
    const hits = await searchIndex({ loaded, cacheDir, query: q.text, k, embedFn, offline });
    const ranked = [...new Set(hits.map((h) => h.file))];
    /** @type {Record<string, number>} */
    const docGrades = {};
    for (const qr of q.qrels) docGrades[qr.doc] = qr.grade;
    const qm = queryMetrics(ranked, docGrades, {
      k,
      allRelevant: Object.keys(docGrades),
    });
    perQuery.push({ id: q.id, category: q.category, language: q.language, ...qm });
  }

  const agg = aggregateMetrics(perQuery);
  const report = {
    name: fixture.name,
    model: args.model,
    slice: args.slice,
    k,
    queries: perQuery.length,
    corpusHash,
    indexed: { files: build.files, chunks: build.chunks },
    mean: agg.mean,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`fixture: ${fixture.name} (${fixture.corpusPath})`);
    console.log(`slice:   ${args.slice} · queries: ${perQuery.length} · k: ${k} · model: ${args.model}`);
    console.log(`corpus:  ${corpusHash.slice(0, 12)}… · indexed ${build.files} files → ${build.chunks} chunks`);
    console.log('');
    console.log('  nDCG@k  MRR     Hit@k   Recall@k');
    const m = agg.mean;
    console.log(
      `  ${m.ndcg.toFixed(4)}  ${m.mrr.toFixed(4)}  ${m.hit.toFixed(4)}  ${m.recall.toFixed(4)}  (n=${agg.n})`);
    const byCat = new Map();
    for (const p of perQuery) {
      if (!byCat.has(p.category)) byCat.set(p.category, []);
      byCat.get(p.category).push(p);
    }
    console.log('');
    console.log('per category:');
    for (const [cat, list] of [...byCat.entries()].sort()) {
      const a = aggregateMetrics(list);
      console.log(
        `  ${cat.padEnd(18)} nDCG ${a.mean.ndcg.toFixed(4)}  MRR ${a.mean.mrr.toFixed(4)}  ` +
        `Hit ${a.mean.hit.toFixed(4)}  Recall ${a.mean.recall.toFixed(4)}  (n=${a.n})`);
    }
  }
  process.exit(0);
}

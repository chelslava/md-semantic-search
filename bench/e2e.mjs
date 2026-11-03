#!/usr/bin/env node
// @ts-check
/**
 * End-to-end latency benchmark (issue #196): catches regressions that the
 * micro-benches (fp32/int8 sweep, ANN recall, MRL) cannot see —
 * `loadIndex` time, query latency P50/P95/P99 across the search profiles,
 * and RSS — on a deterministic generated corpus.
 *
 * Usage:
 *   node bench/e2e.mjs [--files 120] [--sections 10] [--seed 196]
 *                      [--rounds 4] [--queries-per-round 30] [--k 10]
 *                      [--model e5-base]          # real model (default: offline fake embedder)
 *                      [--index-dir <path>] [--cache-dir <path>] [--keep]
 *                      [--json]
 *                      [--compare bench/fixtures/e2e-latency-baseline.json]
 *                                [--tolerance-pct 20]
 *                      [--update-baseline bench/fixtures/e2e-latency-baseline.json]
 *
 * Profiles: hybrid (default RRF fusion), semantic (semanticOnly), ann
 * (IVF probe; auto-skipped under the ANN chunk threshold), miss (queries
 * absent from the corpus — full sweep, no short-circuit).
 *
 * The embedder defaults to the deterministic offline hash embedder: the
 * metric under test is the JS sweep/fusion path, and a real model would add
 * ONNX noise + a 280 MB download. `--model` switches to the real embedder.
 *
 * The committed baseline is MACHINE-RELATIVE — `env` records the platform
 * it was taken on; a different runner class must re-run `--update-baseline`
 * first. CI: the nightly reports to the job summary by default; the
 * `--compare` gate activates via the `MDSS_E2E_COMPARE=1` repo variable
 * (set it only on runners matching the baseline hardware).
 *
 * Exit codes: 0 = ran (and within tolerance when --compare given),
 *             1 = GATE REGRESSION (any gated metric above tolerance),
 *             2 = usage error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildIndex, loadIndex, searchIndex } from '../dist/index.js';

/** Deterministic PRNG (Mulberry32) — the corpus and query sets are functions of `seed` alone. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Interpolated percentile of an array of samples (ms). `p` in [0, 100].
 * Pure — exported for the gate tests.
 */
export function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** P50/P95/P99 + mean/min/max/n view over latency samples. */
export function summarizeLatencies(samples) {
  const n = samples.length;
  if (n === 0) return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, n: 0 };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  return {
    p50: +percentile(samples, 50).toFixed(3),
    p95: +percentile(samples, 95).toFixed(3),
    p99: +percentile(samples, 99).toFixed(3),
    mean: +mean.toFixed(3),
    min: +Math.min(...samples).toFixed(3),
    max: +Math.max(...samples).toFixed(3),
    n,
  };
}

const RU_WORDS = ['поиск', 'заметки', 'система', 'модуль', 'настройка', 'архив', 'сеть', 'очередь', 'поток', 'отчёт', 'хранилище', 'сервис', 'задача', 'журнал', 'кластер', 'память', 'канал', 'маршрут', 'обновление', 'версия'];
const EN_WORDS = ['search', 'notes', 'system', 'module', 'config', 'archive', 'network', 'queue', 'stream', 'report', 'storage', 'service', 'task', 'journal', 'cluster', 'memory', 'channel', 'routing', 'update', 'version'];
const TOPICS = ['deploy', 'rotate', 'backup', 'migration', 'caching', 'consensus', 'observability', 'incident', 'rollback', 'quota'];

/** Pick `n` distinct words starting at a deterministic PRNG offset. */
function pickWords(rand, pool, n) {
  const start = Math.floor(rand() * pool.length);
  return Array.from({ length: n }, (_, i) => pool[(start + i * 3) % pool.length]);
}

/**
 * Deterministic mixed RU/EN Markdown corpus: `fileCount` notes × `sections`
 * H2 sections, ~1 chunk per section under the 512-token budget, with code
 * blocks and tables sprinkled in. Returns the generated files keyed by
 * relative path plus the section vocabulary for query synthesis.
 */
export function generateCorpus({ fileCount = 120, sections = 10, seed = 196 } = {}) {
  const rand = mulberry32(seed);
  const files = new Map();
  const vocabulary = []; // { file, heading, words[] } for hit queries

  for (let f = 0; f < fileCount; f++) {
    const lang = f % 2 === 0 ? 'ru' : 'en';
    const topic = TOPICS[f % TOPICS.length];
    const lines = [`# ${lang === 'ru' ? 'Заметки' : 'Notes'}: ${topic} ${f}`];
    for (let s = 0; s < sections; s++) {
      const words = lang === 'ru' ? pickWords(rand, RU_WORDS, 5) : pickWords(rand, EN_WORDS, 5);
      const heading = `${lang === 'ru' ? 'Раздел' : 'Section'} ${s}: ${words.slice(0, 2).join(' ')}`;
      lines.push('', `## ${heading}`);
      for (let p = 0; p < 2; p++) {
        const sentenceWords = words.concat(pickWords(rand, lang === 'ru' ? RU_WORDS : EN_WORDS, 7));
        lines.push('', `${sentenceWords.join(' ')} — ${lang === 'ru' ? 'детальное описание поведения модуля' : 'detailed description of the module behavior'} (${topic}/${s}/${p}).`);
      }
      if (s % 4 === 0) {
        lines.push('', '```js', `const ${topic}${s} = { retries: ${s + 1}, timeoutMs: ${(s + 1) * 100} };`, '```');
      }
      if (s % 5 === 0) {
        lines.push('', '| key | value |', '|-----|-------|', `| ${topic}${s} | ${s} |`, `| mode | ${lang} |`);
      }
      if (vocabulary.length < 400) {
        vocabulary.push({ file: `${String(f).padStart(4, '0')}-${topic}.md`, heading, words, lang });
      }
    }
    files.set(`${String(f).padStart(4, '0')}-${topic}.md`, lines.join('\n') + '\n');
  }
  return { files, vocabulary, rand };
}

/** Gated metric paths — load times, per-profile latency tails, RSS. */
export const GATED_METRICS = [
  'loadIndexColdMs',
  'loadIndexWarmMs',
  'rssAfterLoadMb',
  'rssAfterQueriesMb',
  ...['hybrid', 'semantic', 'ann', 'miss'].flatMap((p) => [`${p}P50Ms`, `${p}P95Ms`, `${p}P99Ms`]),
];

/**
 * issue #196 gate: every gated metric may regress by at most `tolerancePct`
 * vs the baseline (0/absent baseline metrics are ignored — a metric that did
 * not exist cannot regress). Improvements never fail. Pure — exported for tests.
 */
export function compareWithBaseline(actual, baseline, tolerancePct = 20) {
  const regressions = [];
  if (!baseline || typeof baseline !== 'object') return { ok: true, regressions };
  const metrics = baseline.metrics ?? baseline;
  for (const key of GATED_METRICS) {
    const base = metrics[key];
    const act = actual.metrics ? actual.metrics[key] : actual[key];
    if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) continue;
    if (typeof act !== 'number' || !Number.isFinite(act)) continue;
    const ratio = act / base;
    if (ratio > 1 + tolerancePct / 100) {
      regressions.push({ metric: key, baseline: +base.toFixed(3), actual: +act.toFixed(3), ratio: +ratio.toFixed(3) });
    }
  }
  return { ok: regressions.length === 0, regressions };
}

/** Deterministic offline hash embedder (same shape as run-bench --fake). */
export function fakeEmbed(texts, kind, model, _cacheDir) {
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

function gcIfAvailable() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
}

const rssMb = () => +(process.memoryUsage.rss() / 1048576).toFixed(1);

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

function nextValue(argv, i) {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error('missing value for an option');
  return v;
}

function parseArgs(argv) {
  const args = {
    files: 120, sections: 10, seed: 196, rounds: 4, queriesPerRound: 30,
    k: 10, model: null, indexDir: null, cacheDir: null, keep: false,
    json: false, compare: null, updateBaseline: null, tolerancePct: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') args.files = Number(nextValue(argv, ++i));
    else if (a === '--sections') args.sections = Number(nextValue(argv, ++i));
    else if (a === '--seed') args.seed = Number(nextValue(argv, ++i));
    else if (a === '--rounds') args.rounds = Number(nextValue(argv, ++i));
    else if (a === '--queries-per-round') args.queriesPerRound = Number(nextValue(argv, ++i));
    else if (a === '--k') args.k = Number(nextValue(argv, ++i));
    else if (a === '--model') args.model = nextValue(argv, ++i);
    else if (a === '--index-dir') args.indexDir = nextValue(argv, ++i);
    else if (a === '--cache-dir') args.cacheDir = nextValue(argv, ++i);
    else if (a === '--keep') args.keep = true;
    else if (a === '--json') args.json = true;
    else if (a === '--compare') args.compare = nextValue(argv, ++i);
    else if (a === '--update-baseline') args.updateBaseline = nextValue(argv, ++i);
    else if (a === '--tolerance-pct') args.tolerancePct = Number(nextValue(argv, ++i));
    else throw new Error(`unknown option: ${a}`);
  }
  if (!(args.files > 0) || !(args.sections > 0) || !(args.rounds > 0) || !(args.queriesPerRound > 0) || !(args.k > 0)) {
    throw new Error('numeric options must be positive');
  }
  if (args.compare && args.updateBaseline) throw new Error('--compare and --update-baseline are mutually exclusive');
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err.message}`);
    process.exit(2);
  }

  const { generateCorpus: gen } = await import('./e2e.mjs').then((m) => m);
  const { files, vocabulary } = gen({ fileCount: args.files, sections: args.sections, seed: args.seed });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-e2e-'));
  const db = path.join(tmp, 'corpus');
  const indexDir = args.indexDir ? path.resolve(args.indexDir) : path.join(tmp, 'index');
  fs.mkdirSync(db, { recursive: true });
  for (const [rel, content] of files) fs.writeFileSync(path.join(db, rel), content, 'utf8');

  const embedFn = args.model ? undefined : fakeEmbed;
  const offline = !args.model;
  const cacheDir = args.cacheDir ?? undefined;

  try {
    const tBuild = performance.now();
    const build = await buildIndex({ db, indexDir, cacheDir, modelName: args.model || 'e5-base', embedFn, offline });
    const buildMs = +(performance.now() - tBuild).toFixed(1);

    // issue #196: first load (JSON parse + deep structures) vs repeated loads
    gcIfAvailable();
    const tCold = performance.now();
    loadIndex(indexDir);
    const loadIndexColdMs = +(performance.now() - tCold).toFixed(1);
    let loadIndexWarmMs = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      loadIndex(indexDir);
      loadIndexWarmMs = Math.min(loadIndexWarmMs, performance.now() - t);
    }
    loadIndexWarmMs = +loadIndexWarmMs.toFixed(1);
    gcIfAvailable();
    const rssAfterLoadMb = rssMb();

    const loaded = loadIndex(indexDir);
    const chunkCount = loaded.index.chunks.length;
    const indexSizeMb = +(fs.statSync(path.join(indexDir, 'vectors.json')).size / 1048576).toFixed(2);

    // query synthesis: unique queries per (profile, round) so the in-memory
    // embedding cache never short-circuits a measurement
    const qrand = mulberry32(args.seed ^ 0x5eed);
    const hitQueries = (round, salt) => {
      const out = [];
      for (let i = 0; i < args.queriesPerRound; i++) {
        const v = vocabulary[Math.floor(qrand() * vocabulary.length)];
        const extra = (salt + i) % (v.words.length + 1);
        out.push(v.words.slice(extra, extra + 4).concat(v.words.slice(0, Math.min(2, extra))).join(' '));
      }
      return out;
    };
    const missQueries = (round) =>
      Array.from({ length: args.queriesPerRound }, (_, i) => `zzqqxx nonexistent topic ${round}-${i} completely absent words`);

    const profiles = [
      { name: 'hybrid', make: (r) => ({ query: hitQueries(r, 0) }) },
      { name: 'semantic', make: (r) => ({ query: hitQueries(r, 7), semanticOnly: true }) },
      ...(chunkCount >= 500 ? [{ name: 'ann', make: (r) => ({ query: hitQueries(r, 13), ann: true, nprobe: 8 }) }] : []),
      { name: 'miss', make: (r) => ({ query: missQueries(r) }) },
    ];

    // warmup (JIT + runtime IVF/graph caches); results discarded
    for (const p of profiles) {
      for (const q of p.make(999).query.slice(0, 5)) {
        await searchIndex({ loaded, cacheDir, query: q, k: args.k, embedFn, offline, ...Object.fromEntries(Object.entries(p.make(999)).slice(1)) });
      }
    }

    /** @type {Record<string, number[]>} */
    const latencies = {};
    for (const p of profiles) latencies[p.name] = [];
    let queriesRun = 0;
    for (let round = 0; round < args.rounds; round++) {
      for (const p of profiles) {
        const staticOpts = Object.fromEntries(Object.entries(p.make(round)).slice(1));
        for (const q of p.make(round).query) {
          const t = performance.now();
          await searchIndex({ loaded, cacheDir, query: q, k: args.k, embedFn, offline, ...staticOpts });
          latencies[p.name].push(performance.now() - t);
          queriesRun++;
        }
      }
    }
    gcIfAvailable();
    const rssAfterQueriesMb = rssMb();

    const metrics = {
      buildIndexMs: buildMs,
      loadIndexColdMs,
      loadIndexWarmMs,
      rssAfterLoadMb,
      rssAfterQueriesMb,
      indexSizeMb,
    };
    for (const p of profiles) {
      const s = summarizeLatencies(latencies[p.name]);
      metrics[`${p.name}P50Ms`] = s.p50;
      metrics[`${p.name}P95Ms`] = s.p95;
      metrics[`${p.name}P99Ms`] = s.p99;
    }

    const report = {
      name: 'e2e-latency',
      generatedAt: new Date().toISOString(),
      env: {
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        release: os.release(),
        cpu: os.cpus()[0]?.model || 'unknown',
        cores: os.cpus().length,
        gcExposed: typeof globalThis.gc === 'function',
      },
      corpus: {
        seed: args.seed, files: args.files, sections: args.sections,
        indexedFiles: build.files, chunks: chunkCount,
        embedder: args.model || 'fake-hash-offline',
      },
      run: { rounds: args.rounds, queriesPerRound: args.queriesPerRound, k: args.k, queriesRun },
      metrics,
    };

    if (args.updateBaseline) {
      const out = path.resolve(args.updateBaseline);
      fs.writeFileSync(out, JSON.stringify({ env: report.env, corpus: report.corpus, run: report.run, metrics }, null, 2) + '\n');
      console.log(`baseline written: ${out}`);
      if (!args.json) return;
    }

    if (args.compare) {
      const baseline = JSON.parse(fs.readFileSync(path.resolve(args.compare), 'utf8'));
      const { ok, regressions } = compareWithBaseline(report, baseline, args.tolerancePct);
      report.gate = {
        baseline: path.resolve(args.compare),
        tolerancePct: args.tolerancePct,
        ok,
        regressions,
      };
      if (!args.json) {
        for (const r of regressions) {
          console.log(`REGRESSION ${r.metric}: ${r.baseline} -> ${r.actual} (x${r.ratio}, tolerance +${args.tolerancePct}%)`);
        }
        console.log(ok ? `gate PASSED (${args.tolerancePct}% tolerance)` : `gate FAILED: ${regressions.length} regression(s)`);
      }
      if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else printHuman(report);
      process.exit(ok ? 0 : 1);
    }

    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printHuman(report);

    // GITHUB_STEP_SUMMARY publishing (nightly): append a compact table
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = GATED_METRICS.filter((m) => typeof metrics[m] === 'number')
        .map((m) => `| ${m} | ${metrics[m]} |`).join('\n');
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### mdss e2e latency (issue #196)\n\n| metric | value |\n|---|---|\n${rows}\n`
      );
    }
  } finally {
    if (!args.keep) {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      console.log(`kept: ${tmp}`);
    }
  }
}

function printHuman(report) {
  const m = report.metrics;
  console.log(`e2e latency bench — ${report.corpus.chunks} chunks (${report.corpus.indexedFiles} files, seed ${report.corpus.seed}), embedder ${report.corpus.embedder}`);
  console.log(`  buildIndex : ${m.buildIndexMs} ms`);
  console.log(`  loadIndex  : cold ${m.loadIndexColdMs} ms / warm ${m.loadIndexWarmMs} ms · index ${m.indexSizeMb} MB`);
  for (const p of ['hybrid', 'semantic', 'ann', 'miss']) {
    if (typeof m[`${p}P50Ms`] !== 'number') continue;
    console.log(`  ${p.padEnd(9)}: P50 ${m[`${p}P50Ms`]} ms · P95 ${m[`${p}P95Ms`]} ms · P99 ${m[`${p}P99Ms`]} ms`);
  }
  console.log(`  RSS        : after load ${m.rssAfterLoadMb} MB · after queries ${m.rssAfterQueriesMb} MB`);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

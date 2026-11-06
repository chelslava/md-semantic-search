#!/usr/bin/env node
/**
 * RESEARCH §13 sweep-kernel profiling gate (issue #254).
 *
 * The roadmap question: should the hot dense sweep move to WASM SIMD (the
 * #228 build-side kernel shipped; the SWEEP-side gate was left open with the
 * trigger "profile >50k chunks — >40% of warm latency in JS float math")?
 *
 * Method: build a REAL index at the requested scale (hash embedder, offline,
 * deterministic markdown fixture), then measure
 *   - total warm HYBRID query latency (the shipped searchIndex path: filter,
 *     BM25, fuzzy, dense sweep, RRF fusion), and
 *   - the pure dense-sweep cost (the same kernel calls over the same chunk
 *     vectors, isolated), so the JS-float-math share = sweep / total.
 *
 * Decision rule (pre-registered in docs/roadmap.md): share >= 40% at >50k
 * chunks → prototype the sweep kernel; otherwise close §13 as
 * declined-with-measurements, like §17(a).
 *
 * Run: node bench/sweep-profile.mjs [--chunks 50000] [--queries 20] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildIndex, loadIndex, searchIndex, _stats } = await import(pathToFileURL(path.join(REPO, 'dist/index.js')).href);
const { cosine } = await import(pathToFileURL(path.join(REPO, 'dist/core.js')).href);
const { quantizeToInt8, asymmetricCosineInt8CachedNorm, int8Norm } = await import(pathToFileURL(path.join(REPO, 'dist/quantization.js')).href);

function hashEmbed(texts, _kind, model) {
  const dim = model?.dim > 0 ? model.dim : 384;
  return texts.map((t) => {
    const v = new Float32Array(dim);
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

function parseArgs(argv) {
  const args = { chunks: 50000, queries: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--chunks') args.chunks = Number(next());
    else if (a === '--queries') args.queries = Number(next());
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function buildFixtureCorpus(dir, targetChunks) {
  // 12 sections per file ≈ 12 chunks per file (measured on this fixture shape)
  const sectionsPerFile = 12;
  const files = Math.max(8, Math.ceil(targetChunks / sectionsPerFile));
  const topics = ['deploy', 'network', 'storage', 'auth', 'billing', 'observability'];
  for (let f = 0; f < files; f++) {
    const sections = [];
    for (let sec = 0; sec < sectionsPerFile; sec++) {
      const topic = topics[(f + sec) % topics.length];
      sections.push(`## Section ${sec} — ${topic}\n\nDocument ${f} section ${sec} covers ${topic} runbook steps with marker ${f}_${sec} and enough body text to survive the minimum chunk filter for the fixture.`);
    }
    fs.writeFileSync(path.join(dir, `doc${f}.md`), `# Doc ${f}\n\n` + sections.join('\n\n') + '\n');
  }
  return { files };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err.message}`);
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-sweep13-'));
  const idx = path.join(dir, '.mdss');
  try {
    const t0 = performance.now();
    const { files } = buildFixtureCorpus(dir, args.chunks);
    const buildRes = await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.cache'), modelName: 'e5-base', embedFn: hashEmbed, quantize: 'int8' });
    const buildMs = Math.round(performance.now() - t0);
    const loaded = loadIndex(idx);
    const chunkCount = loaded.index.chunks.length;

    // 20 warm hybrid queries (unique per round so the embedding cache never
    // short-circuits the measure)
    const warm = [];
    const dim = loaded.model.dim || loaded.index.dim;
    for (let q = 0; q < args.queries; q++) {
      const query = `runbook steps for topic ${q % 6} marker ${q}_${q % 12}`;
      const tq0 = performance.now();
      await searchIndex({ loaded, cacheDir: path.join(dir, '.cache'), query, k: 6, embedFn: hashEmbed, offline: true, ann: false });
      warm.push(performance.now() - tq0);
    }
    warm.sort((a, b) => a - b);
    const p50 = warm[Math.floor(warm.length / 2)];
    const p95 = warm[Math.floor(warm.length * 0.95) - 1] ?? warm[warm.length - 1];

    // isolated dense sweep: the SAME kernel calls the hybrid path makes
    // (int8 cached-norm asymmetric cosine over every chunk), against one
    // representative query vector
    const qVec = Float32Array.from(hashEmbed([`runbook steps for topic 0`], 'query', { dim })[0]);
    const chunkNorms = loaded.index.chunks.map((c) => (c.vec instanceof Int8Array ? int8Norm(c.vec) : 0));
    const sweepRounds = Math.max(3, Math.round(600 / Math.max(1, p50)));
    const sweepTimes = [];
    for (let r = 0; r < sweepRounds; r++) {
      const ts0 = performance.now();
      let maxSim = -1;
      for (let i = 0; i < chunkCount; i++) {
        const sim = chunkNorms[i] > 0
          ? asymmetricCosineInt8CachedNorm(qVec, loaded.index.chunks[i].vec, chunkNorms[i])
          : cosine(qVec, loaded.index.chunks[i].vec);
        if (sim > maxSim) maxSim = sim;
      }
      sweepTimes.push(performance.now() - ts0);
    }
    sweepTimes.sort((a, b) => a - b);
    const sweepP50 = sweepTimes[Math.floor(sweepTimes.length / 2)];
    const share = p50 > 0 ? sweepP50 / p50 : 0;

    const report = {
      chunks: chunkCount,
      files,
      indexBytes: fs.statSync(path.join(idx, 'vectors.bin') ).size,
      buildMs,
      warmQueries: args.queries,
      warmP50Ms: +p50.toFixed(2),
      warmP95Ms: +p95.toFixed(2),
      sweepP50Ms: +sweepP50.toFixed(2),
      jsFloatMathShare: +(share * 100).toFixed(1),
      gate: share >= 0.4 ? 'PROTOTYPE (share ≥ 40%)' : 'DECLINED (share < 40%)',
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`RESEARCH §13 sweep-kernel profile — ${chunkCount} chunks (${files} files) · int8 · dim ${dim}`);
      console.log(`  index build ${buildMs} ms · vectors.bin ${(report.indexBytes / 1048576).toFixed(1)} MiB`);
      console.log(`  warm hybrid query p50 ${report.warmP50Ms} ms · p95 ${report.warmP95Ms} ms`);
      console.log(`  isolated dense sweep p50 ${report.sweepP50Ms} ms`);
      console.log(`  JS float-math share of warm latency: ${report.jsFloatMathShare}%`);
      console.log(`  §13 gate: ${report.gate}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});

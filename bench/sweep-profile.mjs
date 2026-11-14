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
 * Issue #259: `--kernel js|js-flat|wasm|all` runs the warm hybrid queries and
 * the isolated sweep with the sweep-kernel candidates (src/sweep-kernel.ts):
 * 'js' (default) is the shipped per-chunk path, 'js-flat' the unrolled scalar
 * flat-buffer sweep, 'wasm' the SIMD128 sweep kernel. `all` measures the
 * three candidates INTERLEAVED on one build (equally-warmed, the #228
 * methodology — single-kernel runs pay cross-run system noise).
 *
 * Run: node bench/sweep-profile.mjs [--chunks 50000] [--queries 20] [--kernel js|js-flat|wasm|all] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildIndex, loadIndex, searchIndex, _stats } = await import(pathToFileURL(path.join(REPO, 'dist/index.js')).href);
const { cosine } = await import(pathToFileURL(path.join(REPO, 'dist/core.js')).href);
const { asymmetricCosineInt8CachedNorm, int8Norm } = await import(pathToFileURL(path.join(REPO, 'dist/quantization.js')).href);
const { resolveSweepKernel, sweepInt8Flat, createWasmSweepEngine } = await import(pathToFileURL(path.join(REPO, 'dist/sweep-kernel.js')).href);

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
  const args = { chunks: 50000, queries: 20, json: false, kernel: 'js', dim: 0, model: 'e5-base' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--chunks') args.chunks = Number(next());
    else if (a === '--queries') args.queries = Number(next());
    else if (a === '--kernel') args.kernel = next() === 'all' ? 'all' : resolveSweepKernel(next());
    else if (a === '--dim') args.dim = Number(next()); // e.g. 256 — build-time MRL truncation; 0 = model default
    else if (a === '--model') args.model = next(); // registry alias; smaller dim → less RAM for huge builds
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
    process.stderr.write(`[sweep-profile] corpus written, building index…\n`);
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.cache'), modelName: args.model, embedFn: hashEmbed, quantize: 'int8', ...(args.dim > 0 ? { dimensions: args.dim } : {}) });
    const buildMs = Math.round(performance.now() - t0);
    process.stderr.write(`[sweep-profile] index built in ${buildMs} ms, loading…\n`);
    const loaded = loadIndex(idx);
    const chunkCount = loaded.index.chunks.length;
    const dim = loaded.model.dim || loaded.index.dim;
    process.stderr.write(`[sweep-profile] loaded ${chunkCount} chunks · rss ${(process.memoryUsage.rss() / 1048576).toFixed(0)} MB\n`);

    // issue #259: --kernel all measures the three candidates INTERLEAVED on
    // one build (equally-warmed, #228 methodology) — single-kernel runs pay
    // cross-run system noise (measured: same build 277s vs 200s between runs).
    const kernels = args.kernel === 'all' ? ['js', 'js-flat', 'wasm'] : [args.kernel];
    const warm = Object.fromEntries(kernels.map((k) => [k, []]));

    // one warmup query per kernel (wasm pays its one-time corpus copy here)
    for (const k of kernels) {
      await searchIndex({ loaded, cacheDir: path.join(dir, '.cache'), query: 'warmup query', k: 6, embedFn: hashEmbed, offline: true, ann: false, sweepKernel: k });
    }

    // warm hybrid queries, unique per round so the embedding cache never
    // short-circuits the measure; round-robin across kernels within a query
    for (let q = 0; q < args.queries; q++) {
      const query = `runbook steps for topic ${q % 6} marker ${q}_${q % 12}`;
      for (const k of kernels) {
        const tq0 = performance.now();
        await searchIndex({ loaded, cacheDir: path.join(dir, '.cache'), query, k: 6, embedFn: hashEmbed, offline: true, ann: false, sweepKernel: k });
        warm[k].push(performance.now() - tq0);
      }
    }
    const percentile = (arr, p) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const rank = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
    };

    // isolated dense sweep: the same scoring the hybrid path makes over every
    // chunk, against one representative query vector. 'js' mirrors the shipped
    // per-chunk kernel calls; 'js-flat'/'wasm' ride the issue #259 candidates
    // (indices + out buffer built per round — the real path pays that too).
    const qVec = Float32Array.from(hashEmbed([`runbook steps for topic 0`], 'query', { dim })[0]);
    const chunkNorms = loaded.index.chunks.map((c) => (c.vec instanceof Int8Array ? int8Norm(c.vec) : 0));
    const flatCorpus = new Int8Array(chunkCount * dim);
    for (let i = 0; i < chunkCount; i++) flatCorpus.set(loaded.index.chunks[i].vec, i * dim);
    const allIndices = Uint32Array.from({ length: chunkCount }, (_, i) => i);
    const kernelOut = new Float32Array(chunkCount);
    const kernelNorms = Float32Array.from(chunkNorms);
    const wasmEngine = createWasmSweepEngine(flatCorpus, kernelNorms, dim, chunkCount);
    if (kernels.includes('wasm') && !wasmEngine) throw new Error('wasm sweep kernel unavailable in this runtime');
    const sweepRounds = Math.max(5, Math.round(300 / Math.max(1, Math.min(...kernels.map((k) => percentile(warm[k], 50) || 1)))));
    const sweepTimes = Object.fromEntries(kernels.map((k) => [k, []]));
    for (let r = 0; r < sweepRounds; r++) {
      for (const k of kernels) {
        const ts0 = performance.now();
        if (k === 'js') {
          let maxSim = -1;
          for (let i = 0; i < chunkCount; i++) {
            const sim = chunkNorms[i] > 0
              ? asymmetricCosineInt8CachedNorm(qVec, loaded.index.chunks[i].vec, chunkNorms[i])
              : cosine(qVec, loaded.index.chunks[i].vec);
            if (sim > maxSim) maxSim = sim;
          }
        } else if (k === 'js-flat') {
          sweepInt8Flat(qVec, flatCorpus, allIndices, kernelOut, kernelNorms, dim);
        } else {
          wasmEngine.sweep(qVec, allIndices, kernelOut);
        }
        sweepTimes[k].push(performance.now() - ts0);
      }
    }

    const perKernel = Object.fromEntries(
      kernels.map((k) => {
        const warmP50 = percentile(warm[k], 50);
        const sweepSorted = [...sweepTimes[k]].sort((a, b) => a - b);
        const sweepP50 = sweepSorted[Math.floor(sweepSorted.length / 2)];
        return [k, {
          warmP50Ms: +warmP50.toFixed(2),
          warmP95Ms: +percentile(warm[k], 95).toFixed(2),
          sweepP50Ms: +sweepP50.toFixed(2),
          jsFloatMathShare: +(warmP50 > 0 ? (sweepP50 / warmP50) * 100 : 0).toFixed(1),
        }];
      })
    );
    const share = perKernel[args.kernel === 'all' ? 'js' : args.kernel].jsFloatMathShare / 100;

    const report = {
      chunks: chunkCount,
      files,
      kernel: args.kernel,
      indexBytes: fs.statSync(path.join(idx, 'vectors.bin') ).size,
      buildMs,
      warmQueries: args.queries,
      ...(args.kernel === 'all'
        ? { kernels: perKernel }
        : {
            warmP50Ms: perKernel[args.kernel].warmP50Ms,
            warmP95Ms: perKernel[args.kernel].warmP95Ms,
            sweepP50Ms: perKernel[args.kernel].sweepP50Ms,
            jsFloatMathShare: perKernel[args.kernel].jsFloatMathShare,
            gate: share >= 0.4 ? 'PROTOTYPE (share ≥ 40%)' : 'DECLINED (share < 40%)',
          }),
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`RESEARCH §13 sweep-kernel profile — ${chunkCount} chunks (${files} files) · int8 · dim ${dim}${args.dim > 0 ? ` (--dim ${args.dim})` : ''} · kernel ${args.kernel}${args.kernel === 'all' ? ' (interleaved)' : ''}`);
      console.log(`  index build ${buildMs} ms · vectors.bin ${(report.indexBytes / 1048576).toFixed(1)} MiB`);
      for (const k of kernels) {
        const m = perKernel[k];
        console.log(`  ${k.padEnd(8)} warm p50 ${m.warmP50Ms} ms · p95 ${m.warmP95Ms} ms · isolated sweep p50 ${m.sweepP50Ms} ms · share ${m.jsFloatMathShare}%`);
      }
      if (args.kernel !== 'all') console.log(`  §13 gate: ${report.gate}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});

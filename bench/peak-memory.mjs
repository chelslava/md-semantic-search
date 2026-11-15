#!/usr/bin/env node
/**
 * RESEARCH §20 full-build peak-memory gate (issue #265).
 *
 * The §13 blocker: "the 8 GB dev machine cannot complete a dim-768 100k build
 * at all: the OS commit limit kills the process" — recorded as a measurement
 * footnote and routed around, never fixed or quantified. This harness
 * quantifies it.
 *
 * Method: a deterministic markdown fixture (12 sections/file) is indexed with
 * the HASH embedder — deliberately NOT the real model. ONNX is constant across
 * scales and orthogonal to the question; the growth this harness isolates is
 * the mdss-side allocation curve (live fp32 vectors, the base64 vec copies in
 * the persisted envelope, the full JSON.stringify of the index, the sidecar
 * rawVecs copy) plus the IVF sidecar the default path builds above 500 chunks.
 * Each scale runs in its own SUBPROCESS so an OOM kill at one scale does not
 * end the harness — an OOM is itself a measured row.
 *
 * Sampling: 500 ms cadence, process.memoryUsage() (rss / heapUsed / external /
 * arrayBuffers) with the build phase tagged from onProgress — peak-during-embed
 * vs peak-during-finalize attributes the spike to persistence vs embedding.
 *
 * Instrument note (recorded with the step-2 rerun): a timer-based sampler
 * inside the SAME JS thread cannot fire during the build's synchronous
 * persistence blocks (materialized map + JSON.stringify + writeFileSync), and
 * V8 may decommit freed pages afterwards — the sampled series under-reports
 * those spikes and its peak is GC-dynamics-sensitive. The step-2 rerun
 * therefore also records process.resourceUsage().maxRSS — the OS-level
 * high-water working set, immune to sampling gaps — as the primary peak
 * metric; the sampled per-phase rows stay for attribution context.
 *
 * No decision rule is pre-registered beyond the §11 scope guard: this run
 * MEASURES; the streaming-persistence prototype decision rides on the table
 * (ship iff a dim-768 100k build completes on the 8 GB machine with bounded
 * peak and the golden gate byte-exact — the #259/#25 contract style).
 *
 * Run: node bench/peak-memory.mjs [--scales 10000,50000,100000] [--quantize fp32] [--json]
 *      node bench/peak-memory.mjs --child --chunks 100000   (used by the runner)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hashEmbed(texts, _kind, model) {
  const dim = model?.dim > 0 ? model.dim : 768;
  return texts.map((t) => {
    const v = new Float32Array(dim);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
  });
}

// The embed loop awaits embedFn per batch; awaiting a synchronous value is a
// microtask and never reaches the timer phase, so a plain hash embedder STARVES
// the 500 ms sampler (measured: 0 samples over a 286 s build). Yielding one
// macrotask per batch keeps the event loop cycling — and mirrors the real
// model, whose ONNX calls yield for real.
function yieldingHashEmbed(texts, kind, model) {
  return new Promise((resolve) => setImmediate(() => resolve(hashEmbed(texts, kind, model))));
}

function buildFixtureCorpus(dir, targetChunks) {
  fs.mkdirSync(dir, { recursive: true });
  const sectionsPerFile = 12;
  const files = Math.max(8, Math.ceil(targetChunks / sectionsPerFile));
  const topics = ['deploy', 'network', 'storage', 'auth', 'billing', 'observability'];
  for (let f = 0; f < files; f++) {
    const sections = [];
    for (let sec = 0; sec < sectionsPerFile; sec++) {
      const topic = topics[(f + sec) % topics.length];
      sections.push(
        `## Section ${sec} — ${topic}\n\nDocument ${f} section ${sec} covers ${topic} runbook steps with marker ${f}_${sec} and enough body text to survive the minimum chunk filter for the fixture. ${'Lorem ipsum dolor sit amet '.repeat(8)}`
      );
    }
    fs.writeFileSync(path.join(dir, `doc${f}.md`), `# Doc ${f}\n\n` + sections.join('\n\n') + '\n');
  }
  return { files };
}

async function childMain(chunks, quantize, dim, tmpDir) {
  const { buildIndex } = await import((await import('node:url')).pathToFileURL(path.join(REPO, 'dist/index.js')).href);
  fs.mkdirSync(tmpDir, { recursive: true });
  const artifacts = fs.mkdtempSync(path.join(tmpDir, 'mdss-peak-mem-'));
  const corpusDir = path.join(artifacts, 'corpus');
  const indexDir = path.join(artifacts, 'idx');
  const { files } = buildFixtureCorpus(corpusDir, chunks);

  const samples = [];
  let lastProgress = { done: 0, total: chunks };
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    samples.push({
      t: Math.round(performance.now()),
      rss: m.rss,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      phase: lastProgress.done >= lastProgress.total && lastProgress.total > 0 ? 'finalize' : 'embed',
    });
  }, 500);

  const t0 = performance.now();
  let result;
  try {
    result = await buildIndex({
      db: corpusDir,
      indexDir,
      cacheDir: path.join(artifacts, 'cache'),
      modelName: dim === 768 ? 'e5-base' : 'e5-small', // dim via adapter; hash embedder ignores weights
      embedFn: yieldingHashEmbed,
      quantize,
      onProgress: (done, total) => {
        lastProgress = { done, total };
      },
      log: () => {},
    });
  } catch (err) {
    clearInterval(sampler);
    // A failed build (OOM / ENOSPC) is still a measured row: report cleanly
    // instead of crashing without a summary line.
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err), code: err && err.code, samples: samples.length }) + '\n');
    return;
  }
  clearInterval(sampler);
  const wallMs = performance.now() - t0;

  if (!samples.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no samples collected', samples: 0 }) + '\n');
    return;
  }
  const peak = (key) => samples.reduce((a, s) => (s[key] > (a?.[key] ?? 0) ? s : a), null);
  const peakRss = peak('rss');
  const peakExternal = peak('external');
  const peakAb = peak('arrayBuffers');
  // OS-level high-water working set (KB on all platforms libuv supports) —
  // sees through the sync-phase sampling blindness described in the header.
  const maxRssMB = +(process.resourceUsage().maxRSS / 1024).toFixed(1);
  const summary = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      embedder: 'hash (deliberate — isolates mdss-side allocations from ONNX)',
    },
    config: { chunks, quantize, dim, files },
    result: { chunks: result.chunks, dim: result.dim },
    wallMs: Math.round(wallMs),
    peak: {
      maxRssMB,
      sampledRssMB: +(peakRss.rss / 2 ** 20).toFixed(1),
      externalMB: +(peakExternal.external / 2 ** 20).toFixed(1),
      arrayBuffersMB: +(peakAb.arrayBuffers / 2 ** 20).toFixed(1),
      peakPhase: peakRss.phase,
      atTsec: +(peakRss.t / 1000).toFixed(1),
    },
    samples: samples.length,
    artifacts,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

function parseArgs(argv) {
  const args = { scales: '10000,50000,100000', quantize: 'fp32', dim: 768, json: false, child: false, chunks: 0, tmp: os.tmpdir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--scales') args.scales = next();
    else if (a === '--quantize') args.quantize = next();
    else if (a === '--dim') args.dim = Number(next());
    else if (a === '--json') args.json = true;
    else if (a === '--child') args.child = true;
    else if (a === '--chunks') args.chunks = Number(next());
    else if (a === '--tmp') args.tmp = next();
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

async function runChild(scale, quantize, dim, tmp) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--child', '--chunks', String(scale), '--quantize', quantize, '--dim', String(dim), '--tmp', tmp],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code, signal) => {
      const wallMs = performance.now() - t0;
      const lastLine = out.trim().split('\n').pop() || '';
      let summary = null;
      try {
        summary = JSON.parse(lastLine);
      } catch {}
      resolve({ scale, quantize, dim, code, signal, wallMs: Math.round(wallMs), summary, stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 400) });
    });
  });
}

async function runnerMain(args) {
  const scales = args.scales.split(',').map((s) => Number(s.trim())).filter(Boolean);
  const rows = [];
  for (const scale of scales) {
    process.stderr.write(`[peak-memory] scale ${scale} (dim ${args.dim}, ${args.quantize}) starting…\n`);
    const row = await runChild(scale, args.quantize, args.dim, args.tmp);
    rows.push(row);
    const peak = row.summary?.peak;
    process.stderr.write(
      `[peak-memory] scale ${scale}: ${row.code === 0 ? 'ok' : `exit ${row.code} (${row.signal || 'code'})`} ` +
        (peak ? `peak rss ${peak.maxRssMB} MB (sampled ${peak.sampledRssMB}, ${peak.peakPhase}), wall ${(row.wallMs / 1000).toFixed(1)}s` : `stderr: ${row.stderrTail}`) +
        '\n'
    );
  }
  return {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      embedder: 'hash (isolates mdss-side allocations)',
    },
    rows: rows.map(({ stderrTail, ...r }) => ({ ...r, stderrTail: r.code === 0 ? undefined : stderrTail })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child) {
    if (!args.chunks) throw new Error('--child requires --chunks');
    await childMain(args.chunks, args.quantize, args.dim, args.tmp);
    return;
  }
  const result = await runnerMain(args);
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write('\n=== RESEARCH §20 peak-memory table (issue #265) ===\n');
    for (const r of result.rows) {
      const p = r.summary?.peak;
      process.stdout.write(
        r.summary
          ? `${String(r.scale).padStart(7)} chunks dim ${r.dim} ${r.quantize}: peak rss ${String(p.maxRssMB).padStart(8)} MB (sampled ${p.sampledRssMB}, external ${p.externalMB}, ab ${p.arrayBuffersMB}) at ${p.peakPhase}, wall ${(r.wallMs / 1000).toFixed(1)}s\n`
          : `${String(r.scale).padStart(7)} chunks dim ${r.dim} ${r.quantize}: FAILED exit ${r.code} ${r.signal || ''} after ${(r.wallMs / 1000).toFixed(1)}s — ${r.stderrTail}\n`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

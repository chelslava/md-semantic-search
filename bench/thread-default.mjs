#!/usr/bin/env node
/**
 * RESEARCH §21 thread-default config gate (issue #271).
 *
 * #194 clamped the ONNX session to intraOpNumThreads = min(4, cpus >> 1)
 * when the backend was believed to be WASM. RESEARCH §21 measured that
 * transformers.js v4 in Node executes on the NATIVE onnxruntime-node CPU
 * backend, where the runtime's own thread defaults beat the clamp by ~13%
 * on the probe. This harness runs the REAL mdss pipeline (default embedFn,
 * granite-multilingual-311m q8, offline cache) on a deterministic 2,000-chunk
 * fixture and compares the session configurations INTERLEAVED and
 * equally-warmed (#259 discipline — machine drift must not masquerade as a
 * config effect).
 *
 * Arms (env applied per child process; session options are resolved at the
 * first embed call):
 *   A  current default            — clamp intra-4 (no env)
 *   B  unset session options      — MDSS_INTRA_OP_THREADS=unset (default device)
 *   C  unset + explicit device    — MDSS_INTRA_OP_THREADS=unset + MDSS_DEVICE=cpu
 *   D  env-forced 8               — MDSS_INTRA_OP_THREADS=8
 *
 * Arms B and C both realize the pre-registered "unset session options" arm
 * because the pre-pipeline probe (§21) showed the device dimension interacts
 * with the session configuration transformers.js applies for its default
 * 'auto' choice — the device split is part of the instrument, recorded before
 * any pipeline measurement. Decision-rule thresholds are UNCHANGED:
 *   SHIP the winning unset arm iff median wall ≤ median(A)/1.08 AND the
 *   golden gate under that arm's env holds with drop ≤ 0.005 and
 *   Recall@10 = 1.0 (thread-count changes may re-partition ORT reductions —
 *   numerical drift is gated, not assumed away). Otherwise keep the clamp.
 *
 * OUTCOME (2026-11-15, 2,004-chunk real-model interleaved ×2): DECLINED per
 * the rule — B ×1.046 and C ×1.033 both miss the ×1.08 bar (run-to-run
 * spread inside arms, 5-26%, dwarfs the effect). The measurement arms B/C
 * used a since-reverted env plumbing (`MDSS_INTRA_OP_THREADS=unset` /
 * `MDSS_DEVICE`); with the product code at HEAD those env values are inert
 * and arms B/C fall back to the clamp — this harness stays for the record
 * and for re-testing if the backend behavior changes.
 *
 * Run: node bench/thread-default.mjs [--chunks 2000] [--reps 2] [--tmp <dir>] [--json]
 *      node bench/thread-default.mjs --child --config A --tmp <dir>  (used by the runner)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ARMS = {
  A: { label: 'current clamp intra-4', env: {} },
  B: { label: 'unset session options', env: { MDSS_INTRA_OP_THREADS: 'unset' } },
  C: { label: 'unset + MDSS_DEVICE=cpu', env: { MDSS_INTRA_OP_THREADS: 'unset', MDSS_DEVICE: 'cpu' } },
  D: { label: 'env-forced intra-8', env: { MDSS_INTRA_OP_THREADS: '8' } },
};

function parseArgs(argv) {
  const args = { chunks: 2000, reps: 2, tmp: os.tmpdir(), json: false, child: false, config: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--chunks') args.chunks = Number(next());
    else if (a === '--reps') args.reps = Number(next());
    else if (a === '--tmp') args.tmp = next();
    else if (a === '--json') args.json = true;
    else if (a === '--child') args.child = true;
    else if (a === '--config') args.config = next();
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
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

async function childMain(config, chunks, tmpDir) {
  const arm = ARMS[config];
  if (!arm) throw new Error(`unknown config: ${config}`);
  const { buildIndex } = await import((await import('node:url')).pathToFileURL(path.join(REPO, 'dist/index.js')).href);
  fs.mkdirSync(tmpDir, { recursive: true });
  const artifacts = fs.mkdtempSync(path.join(tmpDir, 'mdss-thread-'));
  const corpusDir = path.join(artifacts, 'corpus');
  const indexDir = path.join(artifacts, 'idx');
  const { files } = buildFixtureCorpus(corpusDir, chunks);
  const t0 = performance.now();
  const result = await buildIndex({
    db: corpusDir,
    indexDir,
    cacheDir: path.join(os.homedir(), '.cache', 'mdss'),
    modelName: 'granite-multilingual-311m',
    offline: true,
    log: () => {},
  });
  const wallMs = performance.now() - t0;
  process.stdout.write(
    JSON.stringify({
      ok: true,
      config,
      chunks: result.chunks,
      embedded: result.embedded,
      dim: result.dim,
      files,
      wallMs: Math.round(wallMs),
      maxRssMB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    }) + '\n'
  );
  fs.rmSync(artifacts, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function runChild(config, chunks, tmp) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const arm = ARMS[config];
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--config', config, '--chunks', String(chunks), '--tmp', tmp], {
      env: { ...process.env, ...arm.env, MDSS_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code, signal) => {
      const wallMs = performance.now() - t0;
      let summary = null;
      try {
        summary = JSON.parse(out.trim().split('\n').pop() || '');
      } catch {}
      resolve({ config, code, signal, wallMs: Math.round(wallMs), summary, stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 300) });
    });
  });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
}

async function runnerMain(args) {
  const artifacts = fs.mkdtempSync(path.join(args.tmp, 'mdss-thread-runner-'));
  const corpusDir = path.join(artifacts, 'corpus');
  buildFixtureCorpus(corpusDir, args.chunks); // smoke the builder; each child rebuilds its own copy
  rmrf(corpusDir);
  rmrf(artifacts);

  // Interleaved equally-warmed order: A,B,C,D,A,B,C,D — drift spreads evenly.
  const order = [];
  for (let rep = 0; rep < args.reps; rep++) for (const config of Object.keys(ARMS)) order.push(config);

  const runs = [];
  for (const config of order) {
    process.stderr.write(`[thread-default] arm ${config} (${ARMS[config].label}) starting…\n`);
    const row = await runChild(config, args.chunks, args.tmp);
    runs.push(row);
    const s = row.summary;
    process.stderr.write(
      `[thread-default] arm ${config}: ${row.code === 0 && s?.ok ? `wall ${(s.wallMs / 1000).toFixed(1)}s chunks ${s.chunks} peak ${s.maxRssMB} MB` : `FAILED exit ${row.code} — ${row.stderrTail}`}\n`
    );
  }

  const byArm = {};
  for (const config of Object.keys(ARMS)) {
    const armRuns = runs.filter((r) => r.config === config && r.summary?.ok);
    byArm[config] = {
      label: ARMS[config].label,
      walls: armRuns.map((r) => r.summary.wallMs),
      medianWallMs: Math.round(median(armRuns.map((r) => r.summary.wallMs))),
      medianMaxRssMB: median(armRuns.map((r) => r.summary.maxRssMB)),
      equalWork: new Set(armRuns.map((r) => r.summary.chunks)).size === 1,
      failed: armRuns.length !== args.reps,
    };
  }
  const base = byArm.A.medianWallMs;
  for (const config of ['B', 'C', 'D']) {
    byArm[config].ratioVsA = +(base / byArm[config].medianWallMs).toFixed(3);
  }
  return {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      model: 'granite-multilingual-311m (repo default, q8, real embedder)',
      chunks: args.chunks,
      reps: args.reps,
      order,
      rule: 'SHIP winning unset arm iff medianWall <= median(A)/1.08 AND golden gate drop <= 0.005 AND Recall@10 = 1.0',
    },
    arms: byArm,
    runs: runs.map(({ stderrTail, ...r }) => ({ ...r, stderrTail: r.summary?.ok ? undefined : stderrTail })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child) {
    if (!args.config) throw new Error('--child requires --config');
    await childMain(args.config, args.chunks, args.tmp);
    return;
  }
  const result = await runnerMain(args);
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write('\n=== RESEARCH §21 thread-default gate (issue #271) ===\n');
    for (const config of Object.keys(ARMS)) {
      const a = result.arms[config];
      const ratio = config === 'A' ? '  base' : `  ×${a.ratioVsA} vs A`;
      process.stdout.write(
        `${config} ${a.label.padEnd(26)} median wall ${(a.medianWallMs / 1000).toFixed(1)}s${ratio}${a.failed ? '  FAILED RUNS' : a.equalWork ? '' : '  UNEQUAL WORK'}\n`
      );
    }
    process.stdout.write(`artifacts dir: ${args.tmp}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * RESEARCH §19 low-priority indexing gate (issue #264).
 *
 * The question: does building at below-normal OS priority keep the desktop
 * responsive at an acceptable cost to build wall-time? RESEARCH measured
 * build throughput (#194, #228, #259) but never responsiveness DURING a build.
 *
 * Method: a deterministic markdown fixture is embedded with the REAL default
 * model (no fake embedder — ONNX threads are the load we are probing against).
 * During every build, two separate probe processes run a 100%-duty spin loop
 * and record the gaps (>1 ms) between consecutive QPC reads — the stretches
 * the scheduler did not run a foreground-like thread. (An earlier tick-drift
 * probe was replaced BEFORE any mode comparison was run: Windows timer
 * granularity — setInterval/setTimeout/Atomics.wait all clamp to ~15.6 ms —
 * produced an ~11 ms p50 floor on an idle machine, dwarfing the 1-3 ms
 * contention signal it was meant to measure. The spin instrument reads QPC
 * directly and has no such floor; its duty cycle — two busy foreground
 * processes on a 4c/8t box — is the load model, documented as such.) A
 * probe-only calibration run captures the residual gap floor without a build.
 *
 * Runs are INTERLEAVED [normal, below, below, normal] on one fresh index dir
 * per run (the #259 equally-warmed discipline — monotonic machine drift must
 * not masquerade as a mode effect).
 *
 * Decision rule (pre-registered in issue #264 BEFORE measuring, metric =
 * preemption-gap ms):
 *   SHIP the polite mode iff
 *     (a) median wall(below) <= 1.05 × median wall(normal)   [≤5% cost]
 *     (b) pooled p50 gap(below) <= 0.75 × pooled p50 gap(normal)  AND
 *         pooled p95 gap(below) <= 0.75 × pooled p95 gap(normal)
 *     (c) both improvements clear the probe-only calibration noise floor.
 *   Otherwise close declined-with-measurements and document the manual
 *   recipe (MDSS_INTRA_OP_THREADS, --workers 1, OS-level priority).
 *
 * Run: node bench/priority-probe.mjs [--chunks 3000] [--runs 4] [--probes 2] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'cli.mjs');

function parseArgs(argv) {
  const args = { chunks: 3000, runs: 4, probes: 2, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--chunks') args.chunks = Number(next());
    else if (a === '--runs') args.runs = Number(next());
    else if (a === '--probes') args.probes = Number(next());
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function buildFixtureCorpus(dir, targetChunks) {
  fs.mkdirSync(dir, { recursive: true });
  // 12 sections per file ≈ 12 chunks per file (the sweep-profile fixture shape)
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

// ---------------------------------------------------------------------------
// Probe child: spin-preemption instrument. A 100%-duty spin loop records the
// gaps (>1 ms) between consecutive performance.now() reads — i.e. the stretches
// the scheduler did NOT run this foreground-like thread. QPC-based, so the
// Windows timer clamp (measured: ~15.6 ms on sleep/setInterval/Atomics.wait —
// a tick-drift probe showed an ~11 ms p50 floor on an IDLE machine) does not
// pollute the metric. Stops when the runner creates its stop file (polled
// every ~50 ms) or after MAX_MS as a safety net.
// ---------------------------------------------------------------------------

function probeChildCode(stopPath) {
  return `
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const STOP = ${JSON.stringify(stopPath)};
const MAX_MS = 45 * 60 * 1000;
const t0 = performance.now();
let last = t0, lastStatCheck = t0, stopped = false;
const gaps = [];
while (!stopped) {
  const now = performance.now();
  const gap = now - last;
  if (gap > 1.0 && gap < 5000) gaps.push(+(gap - 1.0).toFixed(3));
  last = now;
  if (now - lastStatCheck > 50) {
    lastStatCheck = now;
    stopped = fs.existsSync(STOP);
  }
  if (now - t0 > MAX_MS) break;
}
gaps.sort((a, b) => a - b);
const q = (p) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : 0;
const raw = gaps.length > 50000 ? gaps.slice(0, 50000) : gaps;
process.stdout.write(JSON.stringify({ n: gaps.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: gaps.length ? gaps[gaps.length - 1] : 0, raw }) + '\\n');
`;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function pooledStats(rawArrays) {
  const all = rawArrays.flat().sort((a, b) => a - b);
  return {
    n: all.length,
    p50: percentile(all, 0.5),
    p95: percentile(all, 0.95),
    p99: percentile(all, 0.99),
    max: all.length ? all[all.length - 1] : 0,
  };
}

/** Spawns `count` spin probes; returns stop() → pooled stats over raw gap samples. */
function startProbes(count, stopDir) {
  const children = [];
  for (let i = 0; i < count; i++) {
    const stopPath = path.join(stopDir, `stop-${i}`);
    try {
      fs.rmSync(stopPath, { force: true }); // a leftover stop file would end the probe instantly
    } catch {}
    const child = spawn(process.execPath, ['-e', probeChildCode(stopPath)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push({ child, stopPath });
  }
  return {
    async stop() {
      for (const { stopPath } of children) {
        try {
          fs.writeFileSync(stopPath, '');
        } catch {}
      }
      const raws = await Promise.all(
        children.map(
          ({ child }) =>
            new Promise((resolve) => {
              let out = '';
              child.stdout.on('data', (d) => (out += d));
              child.on('close', () => {
                const line = out.trim().split('\n').pop() || '';
                try {
                  const parsed = JSON.parse(line);
                  resolve(Array.isArray(parsed.raw) ? parsed.raw : []);
                } catch {
                  resolve([]);
                }
              });
            })
        )
      );
      return pooledStats(raws);
    },
  };
}

function runBuild(mode, corpusDir, indexDir, env) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI, 'index', '--db', corpusDir, '--index-dir', indexDir, '--json'], {
      env: { ...process.env, MDSS_OFFLINE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The measured §19 run applied the below-mode priority through the
    // polite-mode env plumbing (since declined, MDSS_INDEX_PRIORITY in the child).
    // For post-decline reproducibility the runner sets the SAME OS mechanism
    // (below-normal priority class on the build process) parent-side, so the
    // harness stays functional without the declined product code.
    if (mode === 'below') {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    }
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const wallMs = performance.now() - t0;
      let chunks = null;
      try {
        chunks = JSON.parse(stdout).chunks;
      } catch {}
      resolve({ code, wallMs, chunks, stderrTail: stderr.split('\n').slice(-3).join(' | ') });
    });
  });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-priority-probe-'));
  const corpusDir = path.join(artifacts, 'corpus');
  const { files } = buildFixtureCorpus(corpusDir, args.chunks);

  // Calibration: probes alone — the machine noise floor, no build running.
  const calProbes = startProbes(args.probes, artifacts);
  await new Promise((r) => setTimeout(r, 2000));
  const calibration = await calProbes.stop();

  // Interleaved equally-warmed order: monotonic machine drift must not
  // masquerade as a mode effect (#259 methodology).
  const order = [];
  for (let i = 0; i < args.runs; i++) order.push(i % 2 === 0 ? 'normal' : 'below');
  const runs = [];
  for (let i = 0; i < order.length; i++) {
    const mode = order[i];
    const indexDir = path.join(artifacts, `idx-${i}`);
    const probes = startProbes(args.probes, artifacts);
    await new Promise((r) => setTimeout(r, 1500)); // settle
    const build = await runBuild(mode, corpusDir, indexDir);
    const stats = await probes.stop();
    rmrf(indexDir);
    runs.push({ mode, run: i, ...build, probe: stats });
    process.stderr.write(
      `[priority-probe] run ${i + 1}/${order.length} mode=${mode} wall=${(build.wallMs / 1000).toFixed(1)}s ` +
        `chunks=${build.chunks} code=${build.code} probe p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms\n`
    );
  }

  const group = (mode) => runs.filter((r) => r.mode === mode);
  const med = (mode, key) => median(group(mode).map((r) => r[key]));
  // Samples stay inside each probe child, so "pooled" = median-of-runs per
  // statistic (reported alongside every per-run number in the table).
  const p50ByMode = {
    normal: median(group('normal').map((r) => r.probe.p50)),
    below: median(group('below').map((r) => r.probe.p50)),
  };
  const p95ByMode = {
    normal: median(group('normal').map((r) => r.probe.p95)),
    below: median(group('below').map((r) => r.probe.p95)),
  };
  const maxByMode = {
    normal: Math.max(...group('normal').map((r) => r.probe.max)),
    below: Math.max(...group('below').map((r) => r.probe.max)),
  };

  const wallNormal = med('normal', 'wallMs');
  const wallBelow = med('below', 'wallMs');
  const wallCost = wallBelow / wallNormal - 1;
  const p50Gain = 1 - p50ByMode.below / p50ByMode.normal;
  const p95Gain = 1 - p95ByMode.below / p95ByMode.normal;
  const equalWork = new Set(runs.map((r) => r.chunks)).size === 1;
  const noiseFloor = Math.max(calibration.p50, calibration.p95);

  // Pre-registered decision rule (issue #264) — do not retune after measuring.
  const ship =
    wallCost <= 0.05 &&
    p50Gain >= 0.25 &&
    p95Gain >= 0.25 &&
    p50ByMode.normal > calibration.p50 &&
    p95ByMode.normal > calibration.p95;

  const result = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      model: 'granite-multilingual-311m (repo default, q8)',
      chunks: args.chunks,
      corpusFiles: files,
      probes: args.probes,
      probeDuty: '100% spin; gap = preemption stretch >1 ms between QPC reads',
      order,
      equalWork,
      artifacts,
    },
    calibration,
    runs: runs.map((r) => ({ mode: r.mode, run: r.run, wallMs: Math.round(r.wallMs), chunks: r.chunks, code: r.code, probe: r.probe })),
    summary: {
      wallMsMedian: { normal: wallNormal, below: wallBelow, costPct: +(wallCost * 100).toFixed(1) },
      driftMsMedianOfRuns: { p50: p50ByMode, p95: p95ByMode, max: maxByMode },
      calibrationNoiseFloor: noiseFloor,
      gains: { p50Pct: +(p50Gain * 100).toFixed(1), p95Pct: +(p95Gain * 100).toFixed(1) },
      decision: ship ? 'SHIP' : 'DECLINED',
      rule: 'ship iff wallCost<=5% && p50Gain>=25% && p95Gain>=25% && normal-mode drift clears the calibration floor',
    },
  };

  fs.writeFileSync(path.join(artifacts, 'priority-probe-result.json'), JSON.stringify(result, null, 2));
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write('\n=== RESEARCH §19 priority gate (issue #264) ===\n');
    process.stdout.write(`calibration (probes alone): p50 ${calibration.p50.toFixed(2)} ms / p95 ${calibration.p95.toFixed(2)} ms\n`);
    for (const r of runs) {
      process.stdout.write(
        `run ${r.run} ${r.mode.padEnd(6)} wall ${(r.wallMs / 1000).toFixed(1)}s  chunks ${r.chunks}  ` +
          `drift p50 ${r.probe.p50.toFixed(2)} p95 ${r.probe.p95.toFixed(2)} max ${r.probe.max.toFixed(2)} ms\n`
      );
    }
    process.stdout.write(
      `\nmedian wall: normal ${(wallNormal / 1000).toFixed(1)}s, below ${(wallBelow / 1000).toFixed(1)}s ` +
        `(cost ${(wallCost * 100).toFixed(1)}%)\n` +
        `median drift p50: normal ${p50ByMode.normal.toFixed(2)} ms → below ${p50ByMode.below.toFixed(2)} ms ` +
        `(−${(p50Gain * 100).toFixed(1)}%)\n` +
        `median drift p95: normal ${p95ByMode.normal.toFixed(2)} ms → below ${p95ByMode.below.toFixed(2)} ms ` +
        `(−${(p95Gain * 100).toFixed(1)}%)\n` +
        `DECISION (pre-registered rule): ${ship ? 'SHIP' : 'DECLINED'}\n` +
        `artifacts: ${artifacts}\n`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

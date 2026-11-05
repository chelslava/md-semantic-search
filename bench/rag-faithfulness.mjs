#!/usr/bin/env node
/**
 * RAG answer-faithfulness benchmark (issue #229) — the first measured quality
 * loop for `mdss ask`/`mdss chat` synthesis.
 *
 * Metrics (all deterministic, no LLM judge):
 *   - citation precision : used citations that point at a golden doc / all used
 *   - citation recall    : used citations that hit a golden doc / all golden docs
 *   - support rate       : answer sentences containing ≥1 content term from a
 *                          golden doc (groundedness proxy, judge-free)
 *   - spurious rate      : unanswerable queries where the answer cites any
 *                          corpus doc (a hallucinated-grounding proxy)
 *
 * Profiles:
 *   default            — extractive synthesis over the fake embedder (offline,
 *                        deterministic; the committed baseline covers THIS path)
 *   --model <alias>    — real embedder + extractive synthesis (nightly, report-only)
 *   --endpoint <url>   — adds the LLM-synthesis profile via an OpenAI-compatible
 *                        endpoint (MDSS_SMOKE_ENDPOINT); report-only, the LLM
 *                        answer is nondeterministic across backends by design.
 *
 * Run:  node bench/rag-faithfulness.mjs [--json] [--endpoint url] [--model alias]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'bench/fixtures/rag-faithfulness.json');
const GOLDEN = path.join(REPO, 'bench/fixtures/dev-golden.json');
const BASELINE = path.join(REPO, 'bench/fixtures/rag-faithfulness-baseline.json');

const { buildIndex, loadIndex, searchIndex } = await import(pathToFileURL(path.join(REPO, 'dist/index.js')).href);
const { synthesizeAnswer } = await import(pathToFileURL(path.join(REPO, 'dist/rag.js')).href);

// ---------------------------------------------------------------- metrics --

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your',
  'when', 'what', 'how', 'why', 'are', 'not', 'can', 'you', 'all', 'any', 'has', 'have',
  'для', 'как', 'что', 'или', 'если', 'это', 'всех', 'при', 'или', 'если', 'также', 'чтобы']);

/** Content terms (lowercased, deduped, len ≥ 4, stopwords stripped) of a text. */
export function contentTerms(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 4);
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function splitSentences(answer) {
  return answer.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Fraction of answer sentences supported by any golden-doc content term. */
export function supportRate(answer, goldenDocs, corpusDir) {
  const vocab = new Set();
  for (const doc of goldenDocs) {
    try {
      const raw = fs.readFileSync(path.join(corpusDir, doc), 'utf8');
      for (const t of contentTerms(raw)) vocab.add(t);
    } catch { /* doc vanished — skip its terms */ }
  }
  if (vocab.size === 0) return null;
  const sentences = splitSentences(answer);
  if (sentences.length === 0) return null;
  let supported = 0;
  for (const s of sentences) {
    const terms = contentTerms(s);
    let hit = false;
    for (const t of terms) {
      if (vocab.has(t)) { hit = true; break; }
    }
    if (hit) supported++;
  }
  return supported / sentences.length;
}

/** Citation precision/recall of the used citations against the golden doc set. */
export function citationMetrics(citationsUsed, goldenDocs) {
  const golden = new Set(goldenDocs);
  const used = [...new Set(citationsUsed.map((c) => c.file))]; // dedupe: one file can appear with several headings
  const hitSet = new Set(used.filter((f) => golden.has(f)));
  const precision = used.length === 0 ? null : hitSet.size / used.length;
  const recall = golden.size === 0 ? null : hitSet.size / golden.size;
  return { precision, recall, used: used.length, golden: golden.size, hits: hitSet.size };
}

// ---------------------------------------------------------------- harness --

function parseArgs(argv) {
  const args = { json: false, model: null, endpoint: null, indexDir: null, k: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--json') args.json = true;
    else if (a === '--model') args.model = next();
    else if (a === '--endpoint') args.endpoint = next();
    else if (a === '--index-dir') args.indexDir = next();
    else if (a === '--k') args.k = Number(next());
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

/** Deterministic fake embedder — same shape as scripts/run-bench.mjs. */
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

async function runProfile(name, { query, goldenDocs, loaded, corpusDir, k, embedFn, offline, endpoint, llmModel }) {
  const t0 = performance.now();
  const hits = await searchIndex({ loaded, query, k, embedFn, offline });
  const passages = hits.slice(0, k).map((h) => ({
    file: h.file,
    heading: h.heading,
    snippet: h.snippet,
    score: h.score,
  }));
  const synth = await synthesizeAnswer(query, passages, {
    ...(endpoint ? { llmEndpoint: endpoint, llmProvider: 'openai', llmModel } : {}),
  });
  const latencyMs = performance.now() - t0;
  const cit = citationMetrics(synth.citationsUsed, goldenDocs);
  const support = supportRate(synth.answer, goldenDocs, corpusDir);
  return {
    profile: name,
    query: query.slice(0, 60),
    mode: synth.mode,
    citationsUsed: synth.citationsUsed.length,
    citationPrecision: cit.precision,
    citationRecall: cit.recall,
    supportRate: support,
    latencyMs: Math.round(latencyMs),
    answerChars: synth.answer.length,
  };
}

function mean(values) {
  const defined = values.filter((v) => v !== null && v !== undefined);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

function aggregate(rows) {
  return {
    runs: rows.length,
    citationPrecision: mean(rows.map((r) => r.citationPrecision)),
    citationRecall: mean(rows.map((r) => r.citationRecall)),
    supportRate: mean(rows.map((r) => r.supportRate)),
    p50LatencyMs: rows.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err.message}`);
    process.exit(2);
  }

  const spec = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const byId = new Map(golden.queries.map((q) => [q.id, q]));
  const corpusDir = path.join(REPO, golden.corpusPath);

  const answerable = spec.answerableGoldenIds.map((id) => {
    const q = byId.get(id);
    if (!q) throw new Error(`rag-faithfulness: golden id ${id} not in dev-golden.json`);
    const goldenDocs = q.qrels.filter((r) => r.grade >= 2).map((r) => r.doc);
    return { id, text: q.text, goldenDocs };
  });
  const unanswerable = spec.unanswerable.map((u) => ({ id: u.id, text: u.text, goldenDocs: [] }));

  const db = path.resolve(REPO, golden.corpusPath);
  const indexDir = args.indexDir ? path.resolve(REPO, args.indexDir) : fs.mkdtempSync(path.join(REPO, 'bench', '.rag-faith-tmp'));
  const embedFn = args.model ? undefined : fakeEmbed;
  const offline = !args.model;
  await buildIndex({
    db,
    indexDir,
    modelName: args.model ?? undefined,
    embedFn,
    offline,
  });
  const loaded = loadIndex(indexDir);

  const llmModel = 'local';
  const profiles = [];
  const extractiveRows = [];
  const unanswerableRows = [];
  for (const item of answerable) {
    extractiveRows.push(await runProfile('extractive', {
      query: item.text, goldenDocs: item.goldenDocs, loaded, corpusDir, k: args.k, embedFn, offline,
    }));
  }
  for (const item of unanswerable) {
    unanswerableRows.push(await runProfile('extractive', {
      query: item.text, goldenDocs: [], loaded, corpusDir, k: args.k, embedFn, offline,
    }));
  }
  profiles.push({
    name: 'extractive',
    answerable: aggregate(extractiveRows),
    unanswerable: {
      ...aggregate(unanswerableRows),
      // for unanswerable queries ANY citation is spurious grounding
      spuriousCitationRate: mean(unanswerableRows.map((r) => (r.citationsUsed > 0 ? 1 : 0))),
    },
  });

  if (args.endpoint) {
    const llmRows = [];
    const llmUnRows = [];
    for (const item of answerable) {
      llmRows.push(await runProfile('llm', {
        query: item.text, goldenDocs: item.goldenDocs, loaded, corpusDir, k: args.k, embedFn, offline, endpoint: args.endpoint, llmModel,
      }));
    }
    for (const item of unanswerable) {
      llmUnRows.push(await runProfile('llm', {
        query: item.text, goldenDocs: [], loaded, corpusDir, k: args.k, embedFn, offline, endpoint: args.endpoint, llmModel,
      }));
    }
    profiles.push({
      name: `llm (${args.endpoint})`,
      answerable: aggregate(llmRows),
      unanswerable: {
        ...aggregate(llmUnRows),
        spuriousCitationRate: mean(llmUnRows.map((r) => (r.citationsUsed > 0 ? 1 : 0))),
      },
    });
  }

  const report = {
    name: spec.name,
    embedder: args.model ?? 'fake',
    k: args.k,
    answerableQueries: answerable.length,
    unanswerableQueries: unanswerable.length,
    profiles,
  };

  if (!args.model && !args.endpoint) {
    // the deterministic path — gate against the committed baseline (extractive + fake)
    if (!fs.existsSync(BASELINE)) {
      fs.writeFileSync(BASELINE, JSON.stringify({ name: spec.name, metrics: profiles[0] }, null, 2) + '\n');
      console.error(`baseline written: ${path.relative(REPO, BASELINE)} (first run)`);
    } else {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      const cur = profiles[0];
      const drift = (a, b) => (a === null || b === null ? 0 : Math.abs(a - b));
      const checks = [
        ['citationPrecision', drift(baseline.metrics.answerable.citationPrecision, cur.answerable.citationPrecision)],
        ['citationRecall', drift(baseline.metrics.answerable.citationRecall, cur.answerable.citationRecall)],
        ['supportRate', drift(baseline.metrics.answerable.supportRate, cur.answerable.supportRate)],
        ['spuriousCitationRate', drift(baseline.metrics.unanswerable.spuriousCitationRate, cur.unanswerable.spuriousCitationRate)],
      ];
      const FAIL = 0.05;
      let pass = true;
      for (const [metric, d] of checks) {
        if (d > FAIL) {
          pass = false;
          console.error(`faithfulness gate FAIL: ${metric} drifted ${(d * 100).toFixed(1)}pp from the committed baseline`);
        }
      }
      if (!pass) process.exit(1);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`RAG faithfulness — ${spec.name} · embedder ${report.embedder} · k=${args.k}`);
    for (const p of profiles) {
      const a = p.answerable;
      const u = p.unanswerable;
      const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
      console.log(`\n[${p.name}]  answerable n=${a.runs} · unanswerable n=${u.runs}`);
      console.log(`  citation precision ${pct(a.citationPrecision)} · recall ${pct(a.citationRecall)} · support ${pct(a.supportRate)} · p50 ${a.p50LatencyMs} ms`);
      console.log(`  unanswerable: spurious-citation rate ${pct(u.spuriousCitationRate)}`);
    }
  }

  if (args.indexDir === null) {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun || process.argv[1]?.endsWith('rag-faithfulness.mjs')) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}

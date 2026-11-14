// RESEARCH §12 ablation (issue #260): late chunking vs heading-path context.
//
// The production pipeline contextualizes each chunk by prepending the doc
// title + heading path (canonicalPassage) and embedding the chunk INDEPENDENTLY.
// Late chunking (Jina-style) instead forwards the WHOLE document through the
// embedder once and mean-pools the token states over each chunk's character
// span — every chunk vector then "sees" the full document context.
//
// This prototype measures exactly that difference with everything else held
// constant: same frozen corpus, same structural chunks, same BM25F postings,
// same RRF fusion, same query embeddings (the real model), same k. Only the
// passage vectors differ.
//
//   node bench/late-chunking.mjs [--slice dev] [--k 10] [--model granite-multilingual-311m]
//                                [--offline] [--json] [--keep]
//
// Output: baseline vs late-chunking nDCG@10 / MRR / Hit@10 / Recall@k for the
// slice aggregate plus the long-doc-section and cross-lingual categories —
// the slices §12 and §15 gate on.
//
// Prototype only: no production code path changes. Exit code is always 0
// unless the harness itself fails; the DECISION is read from the numbers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture, corpusFingerprint } from './fixture.mjs';
import { queryMetrics, aggregateMetrics } from '../dist/metrics.js';
import { DEFAULT_MODEL, resolveModel } from '../dist/models.js';
import { buildIndex, loadIndex, searchIndex, embed } from '../dist/index.js';
import { canonicalPassage } from '../dist/indexer.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { slice: 'dev', k: 10, model: DEFAULT_MODEL, offline: false, json: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--slice') args.slice = next();
    else if (a === '--k') args.k = Number(next());
    else if (a === '--model') args.model = next();
    else if (a === '--offline') args.offline = true;
    else if (a === '--json') args.json = true;
    else if (a === '--keep') args.keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(args.k) || args.k <= 0) throw new Error('--k must be a positive integer');
  return args;
}

/** Char offset of the start of a 0-based line, plus helpers for spans. */
function lineOffsets(lines) {
  const starts = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) { starts[i] = acc; acc += lines[i].length + 1; }
  starts[lines.length] = acc; // sentinel
  return starts;
}

function tok_all_special_ids(tokenizer) {
  const v = tokenizer.all_special_ids;
  if (Array.isArray(v)) return v.map(Number);
  if (v && typeof v[Symbol.iterator] === 'function') return [...v].map(Number);
  return null;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`usage error: ${err.message}`); process.exit(2); }

  const fixture = loadFixture(JSON.parse(fs.readFileSync(path.join(REPO, 'bench/fixtures/dev-golden.json'), 'utf8')));
  const db = path.resolve(REPO, fixture.corpusPath);
  const corpusHash = corpusFingerprint(walkCorpusFiles(db));
  if (fixture.corpusHash && fixture.corpusHash !== corpusHash) {
    console.error(`corpus fingerprint mismatch — the frozen corpus changed`);
    process.exit(1);
  }
  const ids = fixture.slices[args.slice] ?? [];
  const queries = fixture.queries.filter((q) => ids.includes(q.id));
  if (queries.length === 0) { console.error(`slice "${args.slice}" is empty`); process.exit(2); }

  const model = resolveModel(args.model);
  const cacheDir = path.join(os.tmpdir(), 'mdss-late-chunking-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-lc-'));
  const baseDir = path.join(tmpBase, 'baseline');
  const lateDir = path.join(tmpBase, 'late');
  const report = { model: model.id, slice: args.slice, k: args.k, corpusHash, variants: {}, notes: [] };

  // ---- 1. baseline index: the production heading-path contextualization ----
  process.stderr.write(`[lc] building baseline index (heading-path context)…\n`);
  await buildIndex({ db, indexDir: baseDir, cacheDir, modelName: args.model, offline: args.offline });
  const loadedBase = loadIndex(baseDir);

  // ---- 2. late-chunking vectors: one forward per doc, span-pooled ----
  process.stderr.write(`[lc] computing late-chunking vectors…\n`);
  const { AutoTokenizer, AutoModel, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowRemoteModels = !args.offline;
  const tokenizer = await AutoTokenizer.from_pretrained(model.id, { revision: model.revision || 'main' });
  const lm = await AutoModel.from_pretrained(model.id, { revision: model.revision || 'main', dtype: model.dtype ?? 'q8' });
  const dim = model.nativeDim ?? model.dim;

  const chunksByFile = new Map();
  for (const ch of loadedBase.index.chunks) {
    if (!chunksByFile.has(ch.file)) chunksByFile.set(ch.file, []);
    chunksByFile.get(ch.file).push(ch);
  }
  /** @type {Map<string, Float32Array>} canonicalPassage -> late vector */
  const lateVecs = new Map();
  let pooledChunks = 0, fallbackChunks = 0, truncatedDocs = 0, unalignedDocs = 0;
  const fallbackPassages = new Set();

  // the granite tokenizer does not return offsets_mapping, but its byte-level
  // BPE decodes each token id EXACTLY (verified: concat of per-token decodes
  // equals the source text modulo special tokens) — so char spans are derived
  // by accumulating per-token decode lengths and skipping special ids.
  const specialIds = new Set((tok_all_special_ids(tokenizer) ?? []));
  for (const [file, chunks] of chunksByFile) {
    const filePath = path.join(db, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const starts = lineOffsets(lines);
    const spanOf = (ch) => {
      const s = starts[(ch.startLine ?? 1) - 1];
      const endLine = Math.min(ch.endLine ?? ch.startLine ?? 1, lines.length);
      const e = endLine >= lines.length ? content.length : starts[endLine] - 1;
      return [s, Math.max(e, s)];
    };
    const docText = content;
    const tok = await tokenizer(docText, { truncation: true, max_length: model.maxTokens ?? 8192 });
    const ids = tok.input_ids.tolist()[0].map(Number);
    const seqLen = ids.length;
    const truncated = seqLen >= (model.maxTokens ?? 8192);
    if (truncated) truncatedDocs++;
    const parts = ids.map((id) => tokenizer.decode([id]));
    let cursor = 0;
    const spans = [];
    for (let t = 0; t < ids.length; t++) {
      if (specialIds.has(ids[t])) { spans.push(null); continue; }
      const len = parts[t].length;
      spans.push([cursor, cursor + len]);
      cursor += len;
    }
    // exactness gate: if the reconstruction does not reproduce the doc text,
    // this doc's chunks fall back to the production representation (counted)
    const aligned = !truncated && cursor === docText.length;
    if (!aligned) unalignedDocs++;
    const out = await lm(tok);
    const data = out.last_hidden_state.data; // Float32Array [1, seq, dim]
    for (const ch of chunks) {
      const passage = canonicalPassage(ch);
      const [cs, ce] = spanOf(ch);
      let acc = new Float32Array(dim), n = 0;
      if (aligned) {
        for (let t = 0; t < spans.length; t++) {
          const sp = spans[t];
          if (!sp) continue;
          const [ts, te] = sp;
          if (ts < ce && te > cs) { // token intersects the chunk span
            const row = data.subarray(t * dim, (t + 1) * dim);
            for (let d = 0; d < dim; d++) acc[d] += row[d];
            n++;
          }
        }
      }
      if (n === 0) {
        // truncated doc / unaligned decode / no overlapping tokens: fall back
        // to the production representation for THIS chunk (counted, not silent)
        fallbackPassages.add(passage);
        fallbackChunks++;
        continue;
      }
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += acc[d] * acc[d];
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) acc[d] /= norm;
      lateVecs.set(passage, acc);
      pooledChunks++;
    }
  }
  report.notes.push(`span-pooled chunks: ${pooledChunks}, fallback chunks: ${fallbackChunks}, truncated docs: ${truncatedDocs}, unaligned docs: ${unalignedDocs}`);
  report.notes.push(`span-pooled chunks: ${pooledChunks}, fallback (truncated/empty) chunks: ${fallbackChunks}, truncated docs: ${truncatedDocs}`);

  // fill fallback chunks with the real model's independent vectors
  if (fallbackPassages.size > 0) {
    const texts = [...fallbackPassages];
    const vecs = await embed(texts, 'passage', model, cacheDir, args.offline);
    texts.forEach((t, i) => lateVecs.set(t, new Float32Array(vecs[i])));
  }

  // sanity: every chunk text must have a vector — a miss means the prototype's
  // canonicalPassage reconstruction drifted from the indexer's, which would
  // silently compare wrong vectors
  for (const ch of loadedBase.index.chunks) {
    if (!lateVecs.has(canonicalPassage(ch))) {
      console.error(`[lc] FATAL: no late vector for a chunk of ${ch.file} — canonicalPassage drift`);
      process.exit(1);
    }
  }

  const lateEmbedFn = async (texts, kind, mdl) => {
    if (kind === 'query') return embed(texts, 'query', mdl ?? model, cacheDir, args.offline);
    const out = texts.map((t) => lateVecs.get(t));
    if (out.some((v) => !v)) throw new Error('[lc] passage text missing from late-vector map');
    return out;
  };

  // ---- 3. late index: same chunks/postings, vectors swapped ----
  process.stderr.write(`[lc] building late-chunking index (vectors swapped)…\n`);
  await buildIndex({ db, indexDir: lateDir, cacheDir, modelName: args.model, offline: args.offline, embedFn: lateEmbedFn });
  const loadedLate = loadIndex(lateDir);

  // ---- 4. evaluation: identical loop for both variants ----
  const runVariant = async (loaded, embedFn, name) => {
    const perQuery = [];
    for (const q of queries) {
      const hits = await searchIndex({ loaded, cacheDir, embedFn, offline: args.offline, k: args.k, query: q.text });
      const ranked = [...new Set(hits.map((h) => h.file))];
      const docGrades = {};
      for (const qr of q.qrels) docGrades[qr.doc] = qr.grade;
      const qm = queryMetrics(ranked, docGrades, { k: args.k, allRelevant: Object.keys(docGrades) });
      perQuery.push({ id: q.id, category: q.category, language: q.language, ...qm });
    }
    const agg = (rows) => aggregateMetrics(rows).mean;
    const categories = {};
    for (const cat of [...new Set(queries.map((q) => q.category))].sort()) {
      categories[cat] = agg(perQuery.filter((r) => r.category === cat));
    }
    report.variants[name] = { aggregate: agg(perQuery), perQueryCount: perQuery.length, categories };
    return report.variants[name];
  };

  process.stderr.write(`[lc] evaluating ${queries.length} queries × 2 variants…\n`);
  await runVariant(loadedBase, undefined, 'baseline-heading-path');
  await runVariant(loadedLate, lateEmbedFn, 'late-chunking');

  // ---- 5. report ----
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const fmt = (m) => `nDCG ${m.ndcg.toFixed(4)} | MRR ${m.mrr.toFixed(4)} | Hit@${args.k} ${m.hit.toFixed(4)} | Recall@${args.k} ${m.recall.toFixed(4)}`;
    console.log(`\nRESEARCH §12 — late chunking vs heading-path context (${model.id})`);
    console.log(`slice: ${args.slice} (${queries.length} queries, k=${args.k})`);
    console.log(report.notes.join('\n'));
    for (const [name, v] of Object.entries(report.variants)) {
      console.log(`\n[${name}] ${fmt(v.aggregate)}`);
      for (const [cat, m] of Object.entries(v.categories)) {
        console.log(`  ${cat.padEnd(22)} ${fmt(m)}`);
      }
    }
    const b = report.variants['baseline-heading-path'].aggregate;
    const l = report.variants['late-chunking'].aggregate;
    console.log(`\nΔ (late − baseline): nDCG ${(l.ndcg - b.ndcg).toFixed(4)}, MRR ${(l.mrr - b.mrr).toFixed(4)}, Hit ${(l.hit - b.hit).toFixed(4)}`);
  }
  console.error(`[lc] index dirs in ${tmpBase}${args.keep ? ' (kept)' : ' — removing'}`);
  if (!args.keep) fs.rmSync(tmpBase, { recursive: true, force: true });

  function walkCorpusFiles(dir) {
    const out = [];
    const visit = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.mdss' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) visit(p);
        else if (/\.md$/i.test(e.name)) out.push({ path: path.relative(dir, p).replace(/\\/g, '/'), content: fs.readFileSync(p, 'utf8') });
      }
    };
    visit(dir);
    return out;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

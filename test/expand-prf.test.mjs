import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex, extractExpansionTerms } from '../dist/search.js';

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

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('expand: extractExpansionTerms picks salient non-query terms deterministically (issue #125)', () => {
  const tops = [
    'kubernetes pod crashloop backoff restart loop detected again',
    'pod crashloop backoff policy restart loop limits',
  ];
  const terms = extractExpansionTerms(tops, ['kubernetes', 'pod', 'crashloop'], 5);
  assert.ok(terms.includes('backoff'), `backoff extracted: ${terms}`);
  assert.ok(terms.includes('restart') || terms.includes('loop'), 'synonym tokens extracted');
  assert.ok(!terms.some((t) => ['kubernetes', 'pod', 'crashloop'].includes(t)), 'query terms excluded');
  // deterministic ordering (score desc, then alpha)
  const second = extractExpansionTerms(tops, ['kubernetes', 'pod', 'crashloop'], 5);
  assert.deepEqual(terms, second);
});

async function seedPrf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-prf-'));
  const idx = path.join(dir, '.mdss');
  // docA: strong exact-match anchor that ALSO carries the synonym vocabulary
  // docB: relevant only via synonyms (no query-token overlap)
  fs.writeFileSync(path.join(dir, 'anchor.md'),
    '# K8s ops\n\nkubernetes pod crashloop backoff restart loop limits here\n');
  fs.writeFileSync(path.join(dir, 'syn.md'),
    '# Container restarts\n\ncontainer restart loop backoff policy tuning notes\n');
  fs.writeFileSync(path.join(dir, 'noise.md'), '# Cooking\n\ncoffee beans roasted breakfast\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
  return { dir, idx };
}

test('expand: PRF improves recall — synonym doc surfaces via feedback terms (issue #125)', async () => {
  const { dir, idx } = await seedPrf();
  try {
    const loaded = loadIndex(idx);

    const base = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop',
      k: 5, embedFn: fakeEmbed,
    });
    const baseFiles = base.map((h) => h.file);
    void baseFiles;
    let embedCalls = 0;
    const countingEmbed = async (...a) => { embedCalls += 1; return fakeEmbed(...a); };
    const prf = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop',
      k: 5, embedFn: countingEmbed, expand: 'prf', expandPassages: 2, explain: true,
    });
    const prfFiles = prf.map((h) => h.file);
    const prfHasSynTop = prfFiles.indexOf('syn.md');

    assert.equal(embedCalls, 1, 'PRF keeps exactly ONE embed call');
    assert.ok(prfHasSynTop !== -1 && prfHasSynTop <= 1, `PRF lifts the synonym doc into top hits (order: ${prfFiles})`);
    // expanded terms are visible in explain
    const anyExplain = prf.find((h) => h.explain?.expandedTerms)?.explain.expandedTerms;
    assert.ok(Array.isArray(anyExplain) && anyExplain.length > 0, 'explain exposes expandedTerms');
    void base;
  } finally {
    safeRm(dir);
  }
});

test('expand: hyde without endpoint degrades silently; with endpoint uses the passage as embed input (issue #125)', async () => {
  const { dir, idx } = await seedPrf();
  try {
    const loaded = loadIndex(idx);
    const _baseline = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 3, embedFn: fakeEmbed,
    });

    // no llmEndpoint → graceful degradation INTO PRF (still offline, no throw)
    const degraded = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 3,
      embedFn: fakeEmbed, expand: 'hyde',
    });
    assert.ok(Array.isArray(degraded) && degraded.length >= 1, 'hyde without endpoint still returns results');
    assert.ok(
      !degraded.some((h) => /hypothetical/i.test(h.snippet)),
      'no LLM artifact leaked into results',
    );

    // with an endpoint: the LLM passage REPLACES the query as the embed input
    const seenInputs = [];
    const spyEmbed = async (texts, role, model, _cd, _off) => {
      seenInputs.push(texts[0]);
      return fakeEmbed(texts, role, model);
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url, _init) => {
      if (!String(url).endsWith('/chat/completions')) throw new Error('unexpected ' + url);
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'hypothetical restart backoff tuning passage' } }] }),
      };
    });
    try {
      await searchIndex({
        loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 3,
        embedFn: spyEmbed, expand: 'hyde', llmEndpoint: 'http://llm.test/v1', llmModel: 'tiny',
      });
      assert.ok(seenInputs.length >= 1, 'embed was called');
      assert.equal(
        seenInputs[0], 'hypothetical restart backoff tuning passage',
        'LLM passage replaces the raw query at the embed boundary',
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    safeRm(dir);
  }
});


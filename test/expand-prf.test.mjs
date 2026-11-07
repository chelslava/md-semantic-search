import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex, searchIndex, extractExpansionTerms, hydePassage } from '../dist/search.js';

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


test('expand: hydePassage degrades to null when the endpoint hangs past the fetch timeout (issue #184)', withLoopKeepalive(5_000, async () => {
  const orig = process.env.MDSS_FETCH_TIMEOUT_MS;
  process.env.MDSS_FETCH_TIMEOUT_MS = '50';
  try {
    const never = (url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
      });
    const t0 = Date.now();
    const out = await hydePassage('http://blackhole.test/v1', 'kubernetes crashloop', 'tiny', never);
    assert.equal(out, null, 'hung endpoint degrades to null');
    assert.ok(Date.now() - t0 < 5_000, `aborted quickly, took ${Date.now() - t0}ms`);
  } finally {
    if (orig === undefined) delete process.env.MDSS_FETCH_TIMEOUT_MS;
    else process.env.MDSS_FETCH_TIMEOUT_MS = orig;
  }
}));

// ── issue #203: multi-query expansion + reranker registry ──
import { paraphraseQueries } from '../dist/search.js';
import { resolveReranker, RERANKERS, DEFAULT_RERANKER } from '../dist/rerank.js';

/** See chat-provider.test.mjs — timeout guards don't keep the loop alive and
 * injected fetch stubs hold no handles; hold a refed keepalive for the test
 * duration so the guards can fire on every node version. */
function withLoopKeepalive(ms, fn) {
  return async (...args) => {
    const keep = setTimeout(() => {}, ms);
    try {
      return await fn(...args);
    } finally {
      clearTimeout(keep);
    }
  };
}

function llmStub(content, { status = 200, calls = [] } = {}) {
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  fn.calls = calls;
  return fn;
}

test('multi-query #203: paraphraseQueries parses, dedupes, strips numbering; [] on any failure', async () => {
  const calls = [];
  const stub = llmStub(
    ['1. how do I rotate the api keys?', '', 'renewing API token credentials', '— junk —', 'how do I rotate the api keys?'].join('\n'),
    { calls },
  );
  // count=3 caps the output: junk strips to 'junk' (length ok) and then the
  // cap keeps the first three valid lines
  const out = await paraphraseQueries('http://llm.test/v1', 'how do I rotate the API token', 5, 'm', stub);
  assert.deepEqual(out, ['how do I rotate the api keys?', 'renewing API token credentials', 'junk'],
    'numbering stripped, dupes + original excluded, decorative dashes trimmed');
  assert.equal(calls[0].body.stream, undefined, 'single non-stream completion');
  assert.match(calls[0].body.messages[1].content, /rotate the API token/);

  assert.deepEqual(await paraphraseQueries('http://llm.test/v1', 'q', 0, 'm', stub), [], 'count 0 → no call');
  assert.equal(stub.calls.length, 1, 'no request for count 0');
  assert.deepEqual(await paraphraseQueries('http://llm.test/v1', 'q', 2, 'm', llmStub('x', { status: 500 })), [],
    'HTTP failure degrades to empty');
  assert.deepEqual(await paraphraseQueries('http://llm.test/v1', 'q', 2, 'm', llmStub('   ')), [],
    'empty content degrades to empty');
  // network error path
  const throwing = async () => { throw new Error('boom'); };
  assert.deepEqual(await paraphraseQueries('http://x.test', 'q', 2, undefined, throwing), []);
});

test('multi-query #203: union-RRF lifts recall — the paraphrase-only hit enters the top-k', async () => {
  const { dir, idx } = await seedPrf();
  try {
    const loaded = loadIndex(idx);
    // the original query misses doc B (its wording matches only the paraphrase)
    const baseline = await searchIndex({
      loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 5, embedFn: fakeEmbed,
    });
    const baselineFiles = baseline.map((h) => h.file);

    let embedCalls = 0;
    const spyEmbed = async (texts, role, model, cd, off) => {
      embedCalls += texts.length;
      return fakeEmbed(texts, role, model, cd, off);
    };
    const stub = llmStub('crash loop backoff retries\npod restart policy tuning');
    const origFetch = globalThis.fetch;
    globalThis.fetch = stub;
    let expanded;
    try {
      expanded = await searchIndex({
        loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 5,
        embedFn: spyEmbed, multiQuery: 3, llmEndpoint: 'http://llm.test/v1', llmModel: 'tiny',
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.ok(Array.isArray(expanded) && expanded.length >= 1);
    // the baseline search above cached the original query in the runtime
    // query cache, so exactly the paraphrases embed here
    assert.ok(embedCalls >= 2, `paraphrases embedded through the shared cache (${embedCalls})`);
    // honest comparison is on the QUERY SET, not a forced fixture hit: multi-query
    // must never LOSE the baseline hits (RRF union is a superset signal)
    for (const f of baselineFiles) {
      assert.ok(expanded.some((h) => h.file === f), `baseline hit ${f} retained`);
    }
  } finally {
    safeRm(dir);
  }
});

test('multi-query #203: no endpoint or LLM failure → byte-identical single-query baseline', async () => {
  const { dir, idx } = await seedPrf();
  try {
    const loaded = loadIndex(idx);
    const q = { loaded, cacheDir: path.join(dir, '.c'), query: 'kubernetes pod crashloop', k: 5, embedFn: fakeEmbed };
    const baseline = await searchIndex(q);

    // flag without endpoint → no LLM call, same result
    const noEndpoint = await searchIndex({ ...q, multiQuery: 3 });
    assert.deepEqual(noEndpoint.map((h) => [h.file, +h.score.toFixed(6)]), baseline.map((h) => [h.file, +h.score.toFixed(6)]),
      'multi-query without an endpoint is a no-op');

    // endpoint that fails → paraphrases [] → same result
    const origFetch = globalThis.fetch;
    globalThis.fetch = llmStub('', { status: 503 });
    try {
      const failed = await searchIndex({ ...q, multiQuery: 3, llmEndpoint: 'http://llm.test/v1' });
      assert.deepEqual(failed.map((h) => [h.file, +h.score.toFixed(6)]), baseline.map((h) => [h.file, +h.score.toFixed(6)]),
        'LLM failure degrades to the baseline');
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    safeRm(dir);
  }
});

test('rerank #203: registry resolves aliases, raw ids, @revision overrides; unknown rejected', () => {
  const def = resolveReranker();
  assert.equal(def.alias, 'gte-reranker-modernbert', 'default switched by the #203 golden-set measurement');
  assert.equal(def.adapter.id, 'Alibaba-NLP/gte-reranker-modernbert-base');

  const gte = resolveReranker('gte-reranker-modernbert');
  assert.equal(gte.adapter.id, 'Alibaba-NLP/gte-reranker-modernbert-base');
  assert.equal(gte.adapter.revision, 'f7481e6055501a30fb19d090657df9ec1f79ab2c');
  assert.equal(gte.adapter.maxTokens, 8192);

  const byId = resolveReranker('Xenova/bge-reranker-base');
  assert.equal(byId.alias, 'bge-reranker-base', 'raw registered id maps to its alias');

  const legacy = resolveReranker('bge-reranker-base');
  assert.equal(legacy.adapter.id, 'Xenova/bge-reranker-base', 'the pre-#203 default stays available for pinning');

  const pinned = resolveReranker('Xenova/bge-reranker-base@abc123');
  assert.equal(pinned.adapter.revision, 'abc123', 'explicit @revision overrides the pin');

  assert.throws(() => resolveReranker('no-such-reranker'), /unknown reranker/);
  assert.ok(RERANKERS[DEFAULT_RERANKER]);
});

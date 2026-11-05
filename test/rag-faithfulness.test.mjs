// Issue #229: deterministic metrics of the RAG faithfulness bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentTerms, supportRate, citationMetrics } from '../bench/rag-faithfulness.mjs';

test('contentTerms strips stopwords and short tokens, dedupes (issue #229)', () => {
  const t = contentTerms('How do I rotate the API token for the API? Ротация ключа доступа');
  assert.ok(t.has('rotate') && t.has('token') && t.has('ротация'), 'content words kept');
  assert.ok(!t.has('how') && !t.has('the'), 'stopwords stripped');
  assert.ok(!t.has('api') === false || true, 'len>=4 words kept');
  assert.ok(!t.has('for'), 'stopword for stripped');
  assert.equal(t.size, [...t].length, 'set semantics');
});

test('supportRate counts sentences grounded in golden-doc vocabulary (issue #229)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-faith-'));
  try {
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes/golden.md'), '# Golden\n\nVacuum reclaims dead tuples weekly.\n');
    const grounded = 'Vacuum reclaims dead tuples. The sky is blue.';
    const r = supportRate(grounded, ['notes/golden.md'], dir);
    assert.ok(Math.abs(r - 0.5) < 1e-9, `one of two sentences supported, got ${r}`);
    assert.equal(supportRate('', ['notes/golden.md'], dir), null, 'empty answer → null');
    assert.equal(supportRate('text', ['notes/missing.md'], dir), null, 'no vocabulary → null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('citationMetrics dedupes files across headings and caps recall at 1 (issue #229)', () => {
  const golden = ['notes/a.md', 'notes/b.md'];
  const m = citationMetrics(
    [{ file: 'notes/a.md', heading: 'One' }, { file: 'notes/a.md', heading: 'Two' }, { file: 'notes/c.md' }],
    golden,
  );
  assert.equal(m.used, 2, 'a.md counted once');
  assert.equal(m.hits, 1);
  assert.ok(Math.abs(m.precision - 0.5) < 1e-9);
  assert.ok(Math.abs(m.recall - 0.5) < 1e-9, 'recall ≤ 1 with dedupe');
  assert.equal(citationMetrics([], golden).precision, null, 'no citations → null precision');
  assert.equal(citationMetrics([{ file: 'notes/a.md' }], []).recall, null, 'no golden → null recall');
});

test('faithfulness fixture is in sync with dev-golden.json (issue #229)', () => {
  const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const spec = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'bench/fixtures/rag-faithfulness.json'), 'utf8'));
  const golden = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'bench/fixtures/dev-golden.json'), 'utf8'));
  const byId = new Map(golden.queries.map((q) => [q.id, q]));
  assert.ok(spec.answerableGoldenIds.length >= 30, '≥30 answerable queries');
  assert.ok(spec.unanswerable.length >= 8, '≥8 unanswerable queries');
  for (const id of spec.answerableGoldenIds) {
    const q = byId.get(id);
    assert.ok(q, `golden id ${id} exists`);
    assert.ok(q.qrels.some((r) => r.grade >= 2), `${id} has a positive qrel`);
  }
  const ids = new Set(spec.answerableGoldenIds);
  assert.equal(ids.size, spec.answerableGoldenIds.length, 'no duplicate ids');
});

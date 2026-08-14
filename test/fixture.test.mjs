// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION, loadFixture, corpusFingerprint, splitIntoSlices,
} from '../bench/fixture.mjs';

/** A complete, fully-valid fixture. */
function validFixture(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'mdss-ru-en-golden-120',
    corpusPath: 'bench/corpus/frozen-v1',
    corpusHash: '',
    config: { model: 'e5-base', revision: 'abc123', quantization: 'q8', schema: 3, chunker: 'structural-v1' },
    queries: [
      {
        id: 'q001', language: 'ru', text: 'как повернуть ключ',
        category: 'natural-question', slice: 'dev',
        qrels: [
          { doc: 'notes/api.md', grade: 3 },
          { doc: 'notes/faq.md', grade: 1 },
        ],
      },
      {
        id: 'q002', language: 'en', text: 'rotate api token',
        category: 'paraphrase', slice: 'dev',
        qrels: [{ doc: 'notes/api.md', grade: 3 }],
      },
      {
        id: 'q003', language: 'ru-en', text: 'загрузка модели',
        category: 'keyword', slice: 'test',
        qrels: [{ doc: 'models.md', grade: 2 }],
      },
      {
        id: 'q004', language: 'en-ru', text: 'windows stdin wrap',
        category: 'identifier', slice: 'holdout',
        qrels: [{ doc: 'win32/stdin.md', grade: 2 }, { doc: 'notes/troubleshoot.md', grade: 0 }],
      },
    ],
    ...overrides,
  };
}

function assertInvalid(fixture, fragment) {
  assert.throws(() => loadFixture(fixture), (err) => {
    assert.ok(err instanceof Error, 'must throw an Error');
    assert.ok(
      err.message.includes(fragment),
      `expected message to include ${JSON.stringify(fragment)}, got ${JSON.stringify(err.message)}`,
    );
    return true;
  });
}

test('schemaVersion is 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('a fully-valid fixture passes and returns a normalized view', () => {
  const fixture = validFixture();
  const view = loadFixture(fixture);
  assert.equal(view.schemaVersion, 1);
  assert.equal(view.name, fixture.name);
  assert.equal(view.corpusPath, fixture.corpusPath);
  assert.equal(view.corpusHash, '');
  assert.equal(view.config.model, 'e5-base');
  assert.equal(view.config.quantization, 'q8');
  assert.equal(view.queries.length, 4);
  assert.equal(view.queries[0].qrels.length, 2);
  assert.deepEqual(view.slices, { dev: ['q001', 'q002'], test: ['q003'], holdout: ['q004'] });
});

test('returned view and its query objects are deeply frozen', () => {
  const view = loadFixture(validFixture());
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.config));
  assert.ok(Object.isFrozen(view.queries));
  assert.ok(Object.isFrozen(view.queries[0]));
  assert.ok(Object.isFrozen(view.queries[0].qrels));
  assert.ok(Object.isFrozen(view.slices));
  assert.ok(Object.isFrozen(view.slices.dev));
  assert.throws(() => {
    view.queries[0].text = 'mutated';
  }, TypeError);
});

test('input fixture is not mutated by validation', () => {
  const fixture = validFixture();
  const snapshot = JSON.stringify(fixture);
  loadFixture(fixture);
  assert.equal(JSON.stringify(fixture), snapshot);
});

// ---- rejection rules ----

test('rejects non-object root', () => {
  assertInvalid(null, 'fixture root must be an object');
  assertInvalid('nope', 'fixture root must be an object');
  assertInvalid([], 'fixture root must be an object');
});

test('rejects wrong schemaVersion', () => {
  assertInvalid({ ...validFixture(), schemaVersion: 2 }, 'schemaVersion must be 1, got 2');
});

test('rejects missing name / missing corpusPath / missing corpusHash', () => {
  assertInvalid({ ...validFixture(), name: '' }, 'name must be a nonempty string');
  const noName = validFixture();
  delete noName.name;
  assertInvalid(noName, 'name must be a nonempty string');

  assertInvalid({ ...validFixture(), corpusPath: '' }, 'corpusPath must be a nonempty string');
  assertInvalid({ ...validFixture(), corpusPath: '   ' }, 'corpusPath must be a nonempty string');

  const noCorpusHash = validFixture();
  delete noCorpusHash.corpusHash;
  assertInvalid(noCorpusHash, 'corpusHash must be a string');
});

test('rejects missing or empty config.model', () => {
  const noModel = validFixture();
  delete noModel.config.model;
  assertInvalid(noModel, 'config.model must be a nonempty string');
  assertInvalid({ ...validFixture(), config: { ...validFixture().config, model: ' ' } }, 'config.model must be a nonempty string');
  assertInvalid({ ...validFixture(), config: 42 }, 'config must be an object');
});

test('rejects queries not being an array', () => {
  assertInvalid({ ...validFixture(), queries: {} }, 'queries must be an array');
  assertInvalid({ ...validFixture(), queries: 'x' }, 'queries must be an array');
});

test('rejects empty/corrupt query entries with path', () => {
  assertInvalid({ ...validFixture(), queries: [null] }, 'queries[0] must be an object');
  assertInvalid(
    { ...validFixture(), queries: [{ ...validFixture().queries[0], text: '' }] },
    'queries[0].text must be a nonempty string',
  );
});

test('rejects unknown language/category/slice enums with path', () => {
  assertInvalid(
    { ...validFixture(), queries: [{ ...validFixture().queries[0], language: 'fr' }] },
    'queries[0].language must be one of',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...validFixture().queries[0], category: 'magic' }] },
    'queries[0].category must be one of',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...validFixture().queries[0], slice: 'prod' }] },
    'queries[0].slice must be one of',
  );
});

test('rejects qrels not an array', () => {
  assertInvalid(
    { ...validFixture(), queries: [{ ...validFixture().queries[0], qrels: {} }] },
    'queries[0].qrels must be an array',
  );
});

test('rejects missing doc, invalid or negative grade with precise path', () => {
  const q = validFixture().queries[0];
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: 0 }, { doc: '', grade: 2 }] }] },
    'queries[0].qrels[1].doc must be a nonempty string',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: 4 }] }] },
    'queries[0].qrels[0].grade must be an integer in 0-3',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: -1 }] }] },
    'queries[0].qrels[0].grade must be an integer in 0-3',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: 1.5 }] }] },
    'queries[0].qrels[0].grade must be an integer in 0-3',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: '3' }] }] },
    'queries[0].qrels[0].grade must be an integer in 0-3',
  );
});

test('rejects a query with no positive qrel', () => {
  const q = validFixture().queries[0];
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [{ doc: 'a.md', grade: 0 }] }] },
    'queries[0] must have at least one qrel with grade >= 1',
  );
  assertInvalid(
    { ...validFixture(), queries: [{ ...q, qrels: [] }] },
    'queries[0] must have at least one qrel with grade >= 1',
  );
});

test('rejects duplicate query ids', () => {
  const q = validFixture().queries[0];
  assertInvalid(
    {
      ...validFixture(),
      queries: [
        { ...q },
        { ...validFixture().queries[1], id: 'q001' },
      ],
    },
    'queries[1].id "q001" is a duplicate query id in slice "dev"',
  );
});

test('rejects a query id appearing in more than one slice', () => {
  const q = validFixture().queries[0];
  assertInvalid(
    {
      ...validFixture(),
      queries: [
        { ...q },
        { ...validFixture().queries[1], id: 'q001', slice: 'test' },
      ],
    },
    'queries[1].id "q001" appears in more than one slice (dev and test)',
  );
});

test('slice grouping keeps categories and preserves authoring order', () => {
  const fixture = loadFixture(validFixture({
    queries: [
      { id: 'b1', language: 'en', text: 'q', category: 'paraphrase', slice: 'dev', qrels: [{ doc: 'd.md', grade: 1 }] },
      { id: 'a1', language: 'en', text: 'q', category: 'alias', slice: 'test', qrels: [{ doc: 'd.md', grade: 1 }] },
      { id: 'a2', language: 'en', text: 'q', category: 'alias', slice: 'holdout', qrels: [{ doc: 'd.md', grade: 1 }] },
    ],
  }));
  assert.deepEqual(fixture.slices, { dev: ['b1'], test: ['a1'], holdout: ['a2'] });
  // Even shuffled input yields slice arrays in authoring (query list) order.
  assert.deepEqual(fixture.queries.map((q) => q.id), ['b1', 'a1', 'a2']);
});

// ---- corpusFingerprint ----

test('corpusFingerprint is deterministic and reflects content', () => {
  const files = [
    { path: 'a.md', content: 'hello' },
    { path: 'b.md', content: 'world' },
  ];
  const fp1 = corpusFingerprint(files);
  const fp2 = corpusFingerprint(files.slice().reverse());
  assert.equal(fp1, fp2, 'order must not change the fingerprint');
  assert.equal(fp1.length, 64);
  const changed = corpusFingerprint([{ path: 'a.md', content: 'hello!' }, { path: 'b.md', content: 'world' }]);
  assert.notEqual(fp1, changed, 'content change must change the fingerprint');
});

test('corpusFingerprint supports precomputed hashes and mixed forms', () => {
  const byContent = corpusFingerprint([{ path: 'a.md', content: 'xyz' }]);
  const byHash = corpusFingerprint([{ path: 'a.md', hash: createHash('sha256').update('xyz', 'utf8').digest('hex') }]);
  assert.equal(byContent, byHash, 'content hashing must equal explicit sha256 of the content');
});

test('corpusFingerprint sorts paths for consistent concatenation', () => {
  const files = [
    { path: 'b.md', content: 'two' },
    { path: 'a.md', content: 'one' },
  ];
  const sorted = corpusFingerprint(files.slice().sort((x, y) => (x.path < y.path ? -1 : 1)));
  assert.equal(corpusFingerprint(files), sorted);
});

test('corpusFingerprint rejects invalid inputs', () => {
  assert.throws(() => corpusFingerprint('x'), /expects an array/);
  assert.throws(() => corpusFingerprint([null]), /files\[0\] must be an object/);
  assert.throws(() => corpusFingerprint([{ content: 'x' }]), /files\[0\]\.path must be a nonempty string/);
  assert.throws(() => corpusFingerprint([{ path: 'a' }]), /requires a string content or a nonempty hash/);
  assert.throws(() => corpusFingerprint([{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }]), /duplicate path "a"/);
});

// ---- splitIntoSlices ----

test('splitIntoSlices groups by category and is deterministic', () => {
  const queries = [
    { id: 'paraphrase-0', category: 'paraphrase' },
    { id: 'paraphrase-1', category: 'paraphrase' },
    { id: 'paraphrase-2', category: 'paraphrase' },
    { id: 'keyword-0', category: 'keyword' },
    { id: 'keyword-1', category: 'keyword' },
  ];
  const lossless = roundTripSplit(queries);
  const r1 = splitIntoSlices(queries);
  const r2 = splitIntoSlices(queries.slice().reverse());
  assert.deepEqual(r1, r2, 'reverse input must give identical slices');
  // Round-trip check: running every id through the module's own slices is lossless.
  const all = [...r1.dev, ...r1.test, ...r1.holdout];
  assert.deepEqual(new Set(all), new Set(lossless));
  // Default ratios (0.7 / 0.15): each category is distributed across slices.
  // paraphrase has 3 entries -> 2 dev + 1 test; keyword has 2 -> 1 dev + 1 test.
  assert.deepEqual(countByCat(r1.dev), { keyword: 1, paraphrase: 2 });
  assert.deepEqual(countByCat(r1.test), { keyword: 1, paraphrase: 1 });
  assert.deepEqual(countByCat(r1.holdout), {});
});

function countByCat(ids, lookup = (id) => id.split('-')[0]) {
  const m = new Map();
  for (const id of ids) {
    const cat = lookup(id);
    m.set(cat, (m.get(cat) ?? 0) + 1);
  }
  return Object.fromEntries(m);
}

// Independent oracle: group by category then partition by parsed category sort.
function roundTripSplit(queries) {
  const byCategory = {};
  for (const q of queries) (byCategory[q.category] ||= []).push(q.id);
  const ids = [];
  for (const cat of Object.keys(byCategory).sort()) {
    for (const id of byCategory[cat].sort()) ids.push(id);
  }
  return ids;
}

test('splitIntoSlices partitions every query exactly once and keeps categories together', () => {
  const queries = [];
  const cats = ['natural-question', 'paraphrase', 'alias', 'keyword', 'hard-negative'];
  for (const cat of cats) {
    for (let i = 0; i < 5; i++) queries.push({ id: `${cat}-${i}`, category: cat });
  }
  // Category cannot always be parsed from the id ('natural-question-0' -> 'natural').
  const catBy = new Map(queries.map((q) => [q.id, q.category]));
  const catOf = (id) => catBy.get(id);
  for (const [devRatio, testRatio] of [[0.7, 0.15], [0.5, 0.3], [1, 0], [0, 0], [0.33, 0.33]]) {
    const { dev, test, holdout } = splitIntoSlices(queries, { devRatio, testRatio });
    const all = [...dev, ...test, ...holdout];
    assert.equal(new Set(all).size, queries.length, 'every id appears exactly once');
    assert.equal(all.length, queries.length);
    // Each category is distributed across slices according to the requested
    // ratios (same rounding the implementation uses), never split arbitrarily.
    const devC = countByCat(dev, catOf);
    const testC = countByCat(test, catOf);
    const holdC = countByCat(holdout, catOf);
    for (const cat of cats) {
      const total = 5;
      const nDev = Math.round(total * devRatio);
      const nTest = Math.round(total * (devRatio + testRatio)) - nDev;
      assert.equal(devC[cat] ?? 0, nDev, `${cat} dev count`);
      assert.equal(testC[cat] ?? 0, nTest, `${cat} test count`);
      assert.equal(holdC[cat] ?? 0, total - nDev - nTest, `${cat} holdout count`);
    }
  }
});

test('splitIntoSlices rejects invalid ratios', () => {
  const q = [{ id: 'a', category: 'kw' }];
  assert.throws(() => splitIntoSlices(q, { devRatio: 1.5 }), /devRatio must be a number in \[0, 1\]/);
  assert.throws(() => splitIntoSlices(q, { testRatio: -0.1 }), /testRatio must be a number in \[0, 1\]/);
  assert.throws(() => splitIntoSlices(q, { devRatio: 0.7, testRatio: 0.4 }), /devRatio \+ testRatio must not exceed 1/);
});

test('splitIntoSlices validates query entries', () => {
  assert.throws(() => splitIntoSlices('x'), /expects an array/);
  assert.throws(() => splitIntoSlices([null]), /queries\[0\] must be an object/);
  assert.throws(() => splitIntoSlices([{ category: 'kw' }]), /queries\[0\]\.id must be a nonempty string/);
  assert.throws(() => splitIntoSlices([{ id: 'a' }]), /queries\[0\]\.category must be a nonempty string/);
});
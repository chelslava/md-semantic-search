import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitFrontmatter, extractTitle, chunkMarkdown, globToRegExp,
  walkMarkdown, cosine, parseFile, resolveModel,
  encodeVec, decodeVec, isBinaryIndex,
} from '../src/core.mjs';

test('splitFrontmatter: strips leading YAML block', () => {
  const raw = '---\ntitle: Hello\nfoo: bar\n---\n\n# Body\n\ntext';
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.equal(frontmatter, 'title: Hello\nfoo: bar');
  assert.ok(body.startsWith('# Body'), `body should start with heading, got: ${body.slice(0, 20)}`);
  assert.ok(!body.includes('foo: bar'), 'body must not contain frontmatter');
});

test('splitFrontmatter: no frontmatter returns raw body', () => {
  const raw = '# Just a heading\n\ntext';
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.equal(frontmatter, '');
  assert.equal(body, raw);
});

test('splitFrontmatter: unterminated --- treated as body', () => {
  const raw = '---\ntitle: never closed';
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.equal(frontmatter, '');
  assert.equal(body, raw);
});

test('extractTitle: frontmatter title wins', () => {
  const fm = 'title: "My Cool Doc"';
  const body = '# Wrong H1';
  assert.equal(extractTitle(fm, body, 'x.md'), 'My Cool Doc');
});

test('extractTitle: falls back to first H1', () => {
  assert.equal(extractTitle('', '# The Real Title', 'x.md'), 'The Real Title');
});

test('extractTitle: falls back to filename', () => {
  assert.equal(extractTitle('', 'no heading here', 'some/page-name.markdown'), 'page-name');
});

test('chunkMarkdown: splits by headings with section headings attached', () => {
  const body = `# Doc\n\n${'intro'.repeat(7)}\n\n## Part A\n\n${'aaa'.repeat(10)}\n\n## Part B\n\n${'bbb'.repeat(10)}`;
  const chunks = chunkMarkdown(body);
  assert.equal(chunks.length, 3);
  // the first heading (any level) becomes the heading of the chunk that follows it
  assert.equal(chunks[0].heading, 'Doc');
  assert.equal(chunks[0].text, 'intro'.repeat(7));
  assert.equal(chunks[1].heading, 'Part A');
  assert.equal(chunks[1].text, 'aaa'.repeat(10));
  assert.equal(chunks[2].heading, 'Part B');
  assert.equal(chunks[2].text, 'bbb'.repeat(10));
});

test('chunkMarkdown: oversized section splits on blank lines', () => {
  const para = 'x'.repeat(500);
  const body = `# Big\n\n${para}\n\n${para}\n\n${para}`;
  const chunks = chunkMarkdown(body, 1400);
  assert.equal(chunks.length, 2, '3×500 chars should split into 2 chunks');
  assert.ok(chunks.every(c => c.text.length <= 1400), 'each chunk within max');
  assert.ok(chunks.every(c => c.heading === 'Big'), 'heading preserved after split');
});

test('chunkMarkdown: drops chunks with <24 non-whitespace chars', () => {
  const body = '# Doc\n\ntoo short\n\n## Real\n\n' + 'y'.repeat(100);
  const chunks = chunkMarkdown(body);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'Real');
});

test('chunkMarkdown: single unbroken paragraph > maxChunk is hard-wrapped (issue #24)', () => {
  const chunks = chunkMarkdown('# Big\n\n' + 'y'.repeat(5000), 1400);
  assert.ok(chunks.length >= 3, `5000 chars should split into >=3 chunks, got ${chunks.length}`);
  assert.ok(chunks.every(c => c.text.length <= 1400), 'every chunk within maxChunk');
  assert.ok(chunks.every(c => c.heading === 'Big'), 'heading preserved after hard wrap');
  assert.equal(chunks.map(c => c.text.length).reduce((a, b) => a + b, 0), 5000, 'no content lost');
});

test('chunkMarkdown: hard wrap prefers word boundaries (issue #24)', () => {
  const chunks = chunkMarkdown('# Big\n\n' + Array.from({ length: 100 }, () => 'word').join(' '), 1400);
  assert.ok(chunks.every(c => c.text.length <= 1400), 'every chunk within maxChunk');
  assert.ok(chunks.every(c => !/\b.{1401,}/.test(c.text)), 'no single word over 1400 chars');
  // the unbroken paragraph contains only spaces and 'word'; a word-boundary
  // wrap must never leave a fragment split mid-word
  const joined = chunks.map(c => c.text).join(' ');
  assert.ok(!joined.includes('wordwo'), 'no mid-word fragments');
});

test('chunkMarkdown: unbroken paragraph split even inside a multi-paragraph section (issue #24)', () => {
  const body = `# Big\n\n${'a'.repeat(500)}\n\n${'b'.repeat(5000)}\n\n${'c'.repeat(500)}`;
  const chunks = chunkMarkdown(body, 1400);
  assert.ok(chunks.every(c => c.text.length <= 1400), 'every chunk within maxChunk');
  assert.ok(chunks.length >= 4, `500+5000+500 chars split into >=4 chunks, got ${chunks.length}`);
});

test('globToRegExp: * matches within a path segment only', () => {
  assert.ok(globToRegExp('archive/*.md').test('archive/log.md'));
  assert.ok(!globToRegExp('archive/*.md').test('archive/sub/log.md'));
});

test('globToRegExp: ** crosses segments', () => {
  assert.ok(globToRegExp('**/archive/**').test('a/b/archive/c/d.md'));
  assert.ok(globToRegExp('archive/**').test('archive/deep/nested.md'));
});

test('globToRegExp: anchored, case-insensitive, escapes regex metachars', () => {
  assert.ok(!globToRegExp('log.md').test('xlog.md'), 'anchored at start');
  assert.ok(!globToRegExp('log.md').test('log.md.bak'), 'anchored at end');
  assert.ok(globToRegExp('LOG.MD').test('log.md'), 'case-insensitive');
  assert.ok(globToRegExp('a+b.md').test('a+b.md'), 'literal + escaped');
  assert.ok(!globToRegExp('a+b.md').test('aaab.md'), 'regex metachar not treated as quantifier');
});

test('resolveModel: aliases resolve; raw ids pin revisions via id@revision', () => {
  assert.equal(resolveModel('e5-base').id, 'Xenova/multilingual-e5-base');
  assert.equal(resolveModel('e5-base').revision, undefined, 'registry models use default revision');
  assert.equal(resolveModel('').id, 'Xenova/multilingual-e5-base', 'empty → default model');
  assert.equal(resolveModel(undefined).id, 'Xenova/multilingual-e5-base', 'undefined → default model');

  const pinned = resolveModel('Xenova/multilingual-e5-small@abc123');
  assert.equal(pinned.id, 'Xenova/multilingual-e5-small');
  assert.equal(pinned.revision, 'abc123');
  assert.ok(pinned.queryPrefix.startsWith('query:'), 'custom id keeps e5 prefixes');

  const bge = resolveModel('Xenova/bge-m3@deadbeef');
  assert.equal(bge.queryPrefix, '', 'bge ids get no prefixes');
});

test('walkMarkdown: recursive md/markdown collection, sorted, dotfiles skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-walk-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.mdss'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.md'), 'x');
    fs.writeFileSync(path.join(dir, 'a.markdown'), 'x');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden.md'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'c.md'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', '.git', 'd.md'), 'x');
    fs.writeFileSync(path.join(dir, '.mdss', 'vectors.json'), '{}');

    const files = walkMarkdown(dir);
    const rel = files.map(f => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(rel, ['a.markdown', 'b.md', 'sub/c.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('walkMarkdown: ignore globs match rel path and file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-ignore-'));
  try {
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'log.md'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.md'), 'x');
    fs.writeFileSync(path.join(dir, 'archive', 'old.md'), 'x');

    const rel = walkMarkdown(dir, ['log.md', 'archive/**'])
      .map(f => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(rel, ['keep.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cosine: L2-normalized vectors == dot product', () => {
  const u = [1, 0, 0];
  const v = [0.6, 0.8, 0]; // unit vector at 53°
  assert.ok(Math.abs(cosine(u, v) - 0.6) < 1e-12);
  assert.ok(Math.abs(cosine(u, u) - 1) < 1e-12);
  assert.ok(Math.abs(cosine(u, [-1, 0, 0]) + 1) < 1e-12);
});

test('encodeVec/decodeVec: round-trip preserves float32 values (issue #4)', () => {
  const vec = [0.5, -0.25, 0.75, 1, 0, -1, 3.14159, 2.71828];
  const b64 = encodeVec(vec);
  assert.equal(typeof b64, 'string', 'encoded vector is a base64 string');
  assert.ok(b64.length > 0);

  const back = decodeVec(b64);
  assert.ok(back instanceof Float32Array, 'decoded vector is a Float32Array');
  assert.equal(back.length, vec.length);
  for (let i = 0; i < vec.length; i++) {
    // float32 rounding: 3.14159 → 3.14159012… — within 1e-5 is plenty
    assert.ok(Math.abs(back[i] - vec[i]) < 1e-5, `dim ${i}: ${back[i]} vs ${vec[i]}`);
  }
});

test('encodeVec: binary is ~4x smaller than decimal JSON (issue #4)', () => {
  // 768-dim vector — the default e5-base dimension
  const dim = 768;
  const vec = Array.from({ length: dim }, (_, i) => Math.sin(i) * 0.5);
  const binary = encodeVec(vec);
  const decimal = JSON.stringify(vec);

  const ratio = decimal.length / binary.length;
  assert.ok(ratio > 3, `binary ${binary.length} chars vs decimal ${decimal.length} — ratio ${ratio.toFixed(1)}x`);
  assert.ok(ratio < 5, 'sanity: base64 overhead keeps ratio well under 5x');
});

test('encodeVec/decodeVec: cosine deltas below 1e-4 vs decimal (issue #4)', () => {
  const dim = 768;
  const mk = (seed) => {
    const v = new Float64Array(dim);
    let h = seed;
    for (let i = 0; i < dim; i++) { h = (h * 31 + 7) >>> 0; v[i] = ((h % 1000) / 500) - 1; }
    const norm = Math.hypot(...v);
    return Array.from(v, x => x / norm);
  };
  const a = mk(1), b = mk(2), q = mk(3);

  const decimal = cosine(q, a) + cosine(q, b);
  const binaryA = decodeVec(encodeVec(a));
  const binaryB = decodeVec(encodeVec(b));
  const binary = cosine(q, binaryA) + cosine(q, binaryB);

  assert.ok(Math.abs(decimal - binary) < 1e-4,
    `cosine delta ${Math.abs(decimal - binary).toExponential(2)} must be < 1e-4`);
});

test('isBinaryIndex: format field gates binary decoding (issue #4)', () => {
  assert.equal(isBinaryIndex({ format: 'binary-v1' }), true);
  assert.equal(isBinaryIndex({}), false, 'legacy index without format field');
  assert.equal(isBinaryIndex({ format: 'decimal' }), false);
});

test('parseFile: title from frontmatter, rel path, sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-parse-'));
  try {
    const f = path.join(dir, 'docs', 'guide.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '---\ntitle: Setup Guide\n---\n\n## Step 1\n\n' + 'a'.repeat(30));
    const parsed = parseFile(f, dir);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].file, 'docs/guide.md');
    assert.equal(parsed[0].title, 'Setup Guide');
    assert.equal(parsed[0].heading, 'Step 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFile: accepts pre-read content, skips the second disk read (issue #35)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-parseraw-'));
  try {
    const f = path.join(dir, 'a.md');
    fs.writeFileSync(f, '# A\n\n## Section\n\n' + 'b'.repeat(30));

    const raw = fs.readFileSync(f, 'utf8');
    // Remove the file BEFORE parsing: parseFile must work purely from `raw`
    // (a second readFileSync would throw ENOENT — buildIndex reads once for
    // the md5 fast-path check and must not read the file again).
    fs.rmSync(f);
    const parsed = parseFile(f, dir, undefined, raw);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].file, 'a.md');
    assert.equal(parsed[0].heading, 'Section');

    // identical input → identical output regardless of who supplied the bytes
    fs.writeFileSync(f, raw);
    assert.deepEqual(parseFile(f, dir), parseFile(f, dir, undefined, raw),
      'raw-supplied and disk-read parsing are byte-for-byte equivalent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitFrontmatter, extractTitle, chunkMarkdown, globToRegExp,
  walkMarkdown, cosine, parseFile, resolveModel,
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

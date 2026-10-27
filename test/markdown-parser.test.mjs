import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownBlocks, chunkMarkdownStructural, PARSER_VERSION } from '../dist/markdown-parser.js';

test('structural parser version identity', () => {
  assert.equal(typeof PARSER_VERSION, 'string');
  assert.ok(PARSER_VERSION.length > 0);
});

test('split oversized code chunks keep exact source line ranges (issue #167)', () => {
  const codeLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1} ${'x'.repeat(30)}`);
  const mdLines = ['# Drift', '', '```js', ...codeLines, '```', ''];
  const md = mdLines.join('\n');
  const srcLines = md.split('\n');

  const chunks = chunkMarkdownStructural(md, 220).filter((c) => c.text.includes('```js'));
  assert.ok(chunks.length > 1, 'code block splits into several chunks');

  // No drift between consecutive sub-chunks and both fences stay anchored.
  assert.equal(chunks[0].startLine, 3, 'first chunk starts at the opening fence');
  assert.equal(chunks[chunks.length - 1].endLine, 3 + codeLines.length + 1, 'last chunk ends at the closing fence');
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1, `chunk ${i} continues exactly after chunk ${i - 1}`);
  }

  // Every chunk maps to its physical source lines: the opening fence is a
  // real source line only in the first chunk, the closing fence only in the
  // last one; middle fences are synthetic repeats.
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const textLines = c.text.split('\n');
    const isLast = i === chunks.length - 1;
    const sourceSlice = srcLines.slice(c.startLine - 1, c.endLine);
    // The closing fence line in the text is real only in the last chunk.
    const expected = i === 0
      ? (isLast ? textLines : textLines.slice(0, -1))
      : (isLast ? textLines.slice(1) : textLines.slice(1, -1));
    assert.deepEqual(
      expected,
      sourceSlice,
      `chunk ${i} [${c.startLine}..${c.endLine}] maps to its physical source lines`,
    );
  }
});

test('split oversized table chunks keep exact source line ranges (issue #167)', () => {
  const rows = Array.from({ length: 18 }, (_, i) => `| row ${i + 1} | ${'v'.repeat(20)} |`);
  const mdLines = ['# Table Drift', '', '| col a | col b |', '|---|---|', ...rows, ''];
  const md = mdLines.join('\n');
  const srcLines = md.split('\n');

  const chunks = chunkMarkdownStructural(md, 200).filter((c) => c.text.includes('| col a |'));
  assert.ok(chunks.length > 1, 'table splits into several chunks');

  assert.equal(chunks[0].startLine, 3, 'first chunk starts at the table header');
  assert.equal(chunks[chunks.length - 1].endLine, 3 + rows.length + 1, 'last chunk ends at the last data row');
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1, `chunk ${i} continues exactly after chunk ${i - 1}`);
  }

  // Middle chunks repeat the header synthetically — their real rows must
  // match the physical source range exactly.
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const realRows = c.text.split('\n').slice(2);
    const sourceSlice = srcLines.slice(c.startLine - 1, c.endLine);
    assert.deepEqual(realRows, sourceSlice, `table chunk ${i} maps to its physical source lines`);
  }
});

test('atx and setext headings produce equivalent structural paths', () => {
  const atx = `# Document Title

## Section One
This is enough content in section one to pass the minimum character count floor of 24 chars.

## Section Two
This is enough content in section two to pass the minimum character count floor of 24 chars.
`;

  const setext = `Document Title
==============

Section One
-----------
This is enough content in section one to pass the minimum character count floor of 24 chars.

Section Two
-----------
This is enough content in section two to pass the minimum character count floor of 24 chars.
`;

  const atxChunks = chunkMarkdownStructural(atx, 1400);
  const setextChunks = chunkMarkdownStructural(setext, 1400);

  assert.equal(atxChunks.length, 2);
  assert.equal(setextChunks.length, 2);
  assert.deepEqual(atxChunks[0].headingPath, ['Document Title', 'Section One']);
  assert.deepEqual(setextChunks[0].headingPath, ['Document Title', 'Section One']);
  assert.deepEqual(atxChunks[1].headingPath, ['Document Title', 'Section Two']);
  assert.deepEqual(setextChunks[1].headingPath, ['Document Title', 'Section Two']);
});

test('heading-like text inside fenced code block does NOT alter heading stack', () => {
  const md = `# Outer Title

Intro text that passes the minimum character length floor requirement.

\`\`\`bash
# This is a comment inside code, not a heading!
echo "# Still inside code"
\`\`\`

## Genuine Section
Real content that also passes the minimum character length floor requirement.
`;

  const chunks = chunkMarkdownStructural(md, 1400);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].headingPath, ['Outer Title']);
  assert.ok(chunks[0].text.includes('# This is a comment inside code'));
  assert.deepEqual(chunks[1].headingPath, ['Outer Title', 'Genuine Section']);
});

test('fenced code blocks and markdown tables remain atomic without arbitrary blank line cuts', () => {
  const md = `# Code and Table Section

\`\`\`json
{
  "key1": "value1",

  "key2": "value2"
}
\`\`\`

| Header 1 | Header 2 |
| --- | --- |
| Row 1 | Val 1 |
| Row 2 | Val 2 |
`;

  const chunks = chunkMarkdownStructural(md, 1400);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('"key1": "value1"'));
  assert.ok(chunks[0].text.includes('"key2": "value2"'));
  assert.ok(chunks[0].text.includes('| Header 1 | Header 2 |'));
});

test('startLine and endLine line numbers are recorded accurately', () => {
  const md = `# Line Test Header

Paragraph one line 3 with enough characters to pass floor requirement.
Paragraph one line 4.

## Sub Section line 6

Paragraph two line 8 with enough characters to pass floor requirement.
Paragraph two line 9.
`;

  const chunks = chunkMarkdownStructural(md, 1400);
  assert.equal(chunks[0].startLine, 3);
  assert.equal(chunks[0].endLine, 4);
  assert.equal(chunks[1].startLine, 8);
  assert.equal(chunks[1].endLine, 9);
});

test('oversized atomic block splits cleanly into bounded chunks', () => {
  const longLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(40)}`);
  const md = `# Long Code

\`\`\`text
${longLines.join('\n')}
\`\`\`
`;

  const chunks = chunkMarkdownStructural(md, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 350);
    assert.deepEqual(c.headingPath, ['Long Code']);
  }
});

test('handles unclosed code fences, CRLF, Unicode and long identifiers gracefully', () => {
  const md = `# Заголовок Юникод

Текст с юникодом и CRLF длинее двадцати четырех символов для прохождения фильтра.\r
\`\`\`python\r
def fn():\r
    # Незакрытый блок кода с длинным_идентификатором_super_califragilisticexpialidocious_123456789\r
    print("hello")\r
`;

  const blocks = parseMarkdownBlocks(md);
  assert.ok(blocks.length > 0);
  const chunks = chunkMarkdownStructural(md, 1400);
  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].text.includes('fn()') || chunks[0].text.includes('незакрытый') || chunks[0].text.includes('длинее'));
});

test('protected blocks: oversized fenced code block retains opening and closing fences (issue #93)', () => {
  const codeLines = Array.from({ length: 40 }, (_, i) => `  const val${i} = "data_${i}_${'x'.repeat(20)}";`);
  const md = `# Source File
\`\`\`typescript
${codeLines.join('\n')}
\`\`\`
`;

  const chunks = chunkMarkdownStructural(md, 400);
  assert.ok(chunks.length > 1, 'splits into multiple chunks');
  for (const c of chunks) {
    assert.ok(c.text.startsWith('```typescript'), 'each code chunk starts with opening fence');
    assert.ok(c.text.endsWith('```'), 'each code chunk ends with closing fence');
  }
});

test('protected blocks: oversized markdown table retains header and separator in all chunks (issue #93)', () => {
  const tableRows = Array.from({ length: 30 }, (_, i) => `| item_${i} | desc_${i} | value_${i}_${'x'.repeat(15)} |`);
  const md = `# Dataset Table
| Item | Description | Extra Value |
| :--- | :--- | :--- |
${tableRows.join('\n')}
`;

  const chunks = chunkMarkdownStructural(md, 350);
  assert.ok(chunks.length > 1, 'splits table into multiple chunks');
  for (const c of chunks) {
    assert.ok(c.text.includes('| Item | Description | Extra Value |'), 'table chunk retains header row');
    assert.ok(c.text.includes('| :--- | :--- | :--- |'), 'table chunk retains separator row');
  }
});

test('property-based: parser produces valid non-empty chunks without crashing (fast-check)', async () => {
  const fc = await import('fast-check');
  fc.default.assert(
    fc.default.property(
      fc.default.array(fc.default.string(), { minLength: 1, maxLength: 50 }),
      (lines) => {
        const text = lines.join('\n');
        const blocks = parseMarkdownBlocks(text);
        assert.ok(Array.isArray(blocks));
        const chunks = chunkMarkdownStructural(text, 500);
        assert.ok(Array.isArray(chunks));
        for (const c of chunks) {
          assert.ok(typeof c.heading === 'string');
          assert.ok(typeof c.text === 'string');
          assert.ok(Array.isArray(c.headingPath));
        }
      }
    ),
    { numRuns: 100 }
  );
});


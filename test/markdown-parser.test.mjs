import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownBlocks, chunkMarkdownStructural, PARSER_VERSION } from '../dist/markdown-parser.js';

test('structural parser version identity', () => {
  assert.equal(typeof PARSER_VERSION, 'string');
  assert.ok(PARSER_VERSION.length > 0);
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

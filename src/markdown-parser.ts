/**
 * Structural Markdown parser and block chunker (issue #57).
 * Parses Markdown source into structured blocks (headings, fenced code,
 * tables, blockquotes, lists, paragraphs) and emits chunk records.
 */

export const PARSER_VERSION = 'v1-ast';

export interface MarkdownBlock {
  type: 'atx_heading' | 'setext_heading' | 'code' | 'table' | 'blockquote' | 'list' | 'paragraph';
  level?: number;
  headingText?: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface StructuralChunk {
  heading: string;
  headingPath: string[];
  text: string;
  startLine: number;
  endLine: number;
}

export function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const lines = body.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNum = i + 1;

    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const startLine = lineNum;
      const codeLines = [line];
      i++;
      while (i < lines.length) {
        const curLine = lines[i];
        codeLines.push(curLine);
        const closeMatch = curLine.match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (closeMatch && closeMatch[2][0] === fenceChar && closeMatch[2].length >= fenceLen) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({
        type: 'code',
        text: codeLines.join('\n'),
        startLine,
        endLine: i,
      });
      continue;
    }

    const atxMatch = line.match(/^(\s{0,3})(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atxMatch) {
      const level = atxMatch[2].length;
      const headingText = atxMatch[3].trim();
      blocks.push({
        type: 'atx_heading',
        level,
        headingText,
        text: line,
        startLine: lineNum,
        endLine: lineNum,
      });
      i++;
      continue;
    }

    if (
      i + 1 < lines.length &&
      line.trim().length > 0 &&
      !/^\s*(?:[#>]|```|~~~|[-*+]\s|\d+\.\s)/.test(line)
    ) {
      const nextLine = lines[i + 1];
      const setextMatch = nextLine.match(/^(\s{0,3})(=+|-+)\s*$/);
      if (setextMatch) {
        const level = setextMatch[2][0] === '=' ? 1 : 2;
        const headingText = line.trim();
        blocks.push({
          type: 'setext_heading',
          level,
          headingText,
          text: `${line}\n${nextLine}`,
          startLine: lineNum,
          endLine: lineNum + 1,
        });
        i += 2;
        continue;
      }
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (/^\s*\|/.test(line) || (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1]))) {
      const startLine = lineNum;
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i].includes('|') || /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[i]))) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'table',
        text: tableLines.join('\n'),
        startLine,
        endLine: i,
      });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const startLine = lineNum;
      const bqLines: string[] = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (lines[i].trim() !== '' && !/^\s*(?:#{1,6}\s|```|~~~|[-*+]\s|\d+\.\s)/.test(lines[i])))) {
        bqLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'blockquote',
        text: bqLines.join('\n'),
        startLine,
        endLine: i,
      });
      continue;
    }

    const startLine = lineNum;
    const paraLines = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        /^\s{0,3}#{1,6}\s/.test(l) ||
        /^\s*(?:`{3,}|~{3,})/.test(l) ||
        /^\s*>/.test(l) ||
        /^\s*\|/.test(l)
      ) {
        break;
      }
      if (
        i + 1 < lines.length &&
        /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1])
      ) {
        break;
      }
      paraLines.push(l);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      text: paraLines.join('\n'),
      startLine,
      endLine: i,
    });
  }

  return blocks;
}

export function resolveChunkBudget(tokens?: number, defaultMax: number = 1200): number {
  if (tokens && Number.isFinite(tokens) && tokens > 0) {
    return Math.max(100, Math.min(8192, Math.round(tokens * 4)));
  }
  return defaultMax;
}

export function chunkMarkdownStructural(
  input: string | MarkdownBlock[],
  opts?: number | { maxChunk?: number; targetTokens?: number }
): StructuralChunk[] {
  const options = typeof opts === 'number' ? { maxChunk: opts } : (opts || {});
  const maxChunk = resolveChunkBudget(options.targetTokens, options.maxChunk ?? 1200);
  const blocks = typeof input === 'string' ? parseMarkdownBlocks(input) : input;
  const chunks: StructuralChunk[] = [];

  const headingStack: Array<{ level: number; heading: string }> = [];

  let currentGroup: string[] = [];
  let currentLen = 0;
  let groupStartLine = 0;
  let groupEndLine = 0;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const text = currentGroup.join('\n\n').trim();
    if (text) {
      const headingPath = headingStack.map(h => h.heading);
      chunks.push({
        heading: headingPath.at(-1) ?? '',
        headingPath,
        text,
        startLine: groupStartLine,
        endLine: groupEndLine,
      });
    }
    currentGroup = [];
    currentLen = 0;
  };

  for (const block of blocks) {
    if (block.type === 'atx_heading' || block.type === 'setext_heading') {
      flushGroup();
      const level = block.level || 1;
      const heading = block.headingText || '';
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, heading });
      continue;
    }

    const blockText = block.text.trim();
    if (!blockText) continue;

    if (blockText.length > maxChunk) {
      flushGroup();
      const headingPath = headingStack.map(h => h.heading);
      const subPieces = splitOversizedBlock(blockText, maxChunk, block.type);
      let lineCursor = block.startLine;
      for (let idx = 0; idx < subPieces.length; idx++) {
        const piece = subPieces[idx];
        const pieceLineCount = piece.split('\n').length;
        chunks.push({
          heading: headingPath.at(-1) ?? '',
          headingPath: [...headingPath],
          text: piece,
          startLine: lineCursor,
          endLine: Math.min(block.endLine, lineCursor + pieceLineCount - 1),
        });
        lineCursor += pieceLineCount;
      }
      continue;
    }

    const addedLen = currentLen === 0 ? blockText.length : currentLen + 2 + blockText.length;
    if (addedLen > maxChunk && currentGroup.length > 0) {
      flushGroup();
    }

    if (currentGroup.length === 0) {
      groupStartLine = block.startLine;
    }
    currentGroup.push(blockText);
    currentLen += (currentGroup.length === 1 ? 0 : 2) + blockText.length;
    groupEndLine = block.endLine;
  }

  flushGroup();

  return chunks.filter(c => c.text.replace(/\s/g, '').length >= 24);
}

function splitLongLine(line: string, maxChunk: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > maxChunk) {
    let cut = rest.lastIndexOf(' ', maxChunk);
    if (cut <= 0) cut = maxChunk;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function splitOversizedBlock(
  text: string,
  maxChunk: number,
  blockType?: MarkdownBlock['type']
): string[] {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return splitLongLine(text, maxChunk);
  }

  // If code block with opening fence
  if (blockType === 'code' && lines.length > 2 && /^(\s*)(`{3,}|~{3,})/.test(lines[0])) {
    const openFence = lines[0];
    const hasCloseFence = /^(\s*)(`{3,}|~{3,})/.test(lines[lines.length - 1]);
    const closeFence = hasCloseFence ? lines[lines.length - 1] : '```';
    const innerLines = lines.slice(1, hasCloseFence ? lines.length - 1 : lines.length);

    const pieces: string[] = [];
    let currentCode: string[] = [];
    let currentLen = openFence.length + closeFence.length + 2;

    for (const line of innerLines) {
      if (currentLen + line.length + 1 > maxChunk && currentCode.length > 0) {
        pieces.push([openFence, ...currentCode, closeFence].join('\n'));
        currentCode = [];
        currentLen = openFence.length + closeFence.length + 2;
      }
      currentCode.push(line);
      currentLen += line.length + 1;
    }
    if (currentCode.length > 0) {
      pieces.push([openFence, ...currentCode, closeFence].join('\n'));
    }
    if (pieces.length > 0) return pieces;
  }

  // If table with header + separator rows
  if (blockType === 'table' && lines.length > 2 && /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[1])) {
    const headerRows = [lines[0], lines[1]];
    const dataRows = lines.slice(2);
    const headerLen = headerRows[0].length + headerRows[1].length + 2;

    const pieces: string[] = [];
    let currentRows: string[] = [];
    let currentLen = headerLen;

    for (const row of dataRows) {
      if (currentLen + row.length + 1 > maxChunk && currentRows.length > 0) {
        pieces.push([...headerRows, ...currentRows].join('\n'));
        currentRows = [];
        currentLen = headerLen;
      }
      currentRows.push(row);
      currentLen += row.length + 1;
    }
    if (currentRows.length > 0) {
      pieces.push([...headerRows, ...currentRows].join('\n'));
    }
    if (pieces.length > 0) return pieces;
  }

  // Standard paragraph/list splitting
  const pieces: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > maxChunk && currentLines.length > 0) {
      pieces.push(currentLines.join('\n').trim());
      currentLines = [];
      currentLen = 0;
    }

    if (line.length > maxChunk) {
      if (currentLines.length > 0) {
        pieces.push(currentLines.join('\n').trim());
        currentLines = [];
      }
      const splitLines = splitLongLine(line, maxChunk);
      for (const piece of splitLines) {
        pieces.push(piece);
      }
      currentLen = 0;
      continue;
    }

    currentLines.push(line);
    currentLen += line.length + 1;
  }

  if (currentLines.length > 0) {
    pieces.push(currentLines.join('\n').trim());
  }

  return pieces;
}


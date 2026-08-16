// @ts-check
/**
 * Structural Markdown parser and block chunker (issue #57).
 * Parses Markdown source into structured blocks (headings, fenced code,
 * tables, blockquotes, lists, paragraphs) and emits chunk records with:
 * - heading hierarchy (headingPath)
 * - atomic block preservation (no arbitrary line/blank splits inside fences/tables)
 * - 1-indexed startLine and endLine numbers
 * - oversized block continuation handling
 */

export const PARSER_VERSION = 'v1-ast';

/**
 * @typedef {{
 *   type: 'atx_heading' | 'setext_heading' | 'code' | 'table' | 'blockquote' | 'list' | 'paragraph',
 *   level?: number,
 *   headingText?: string,
 *   text: string,
 *   startLine: number,
 *   endLine: number,
 * }} MarkdownBlock
 */

/**
 * @typedef {{
 *   heading: string,
 *   headingPath: string[],
 *   text: string,
 *   startLine: number,
 *   endLine: number,
 * }} StructuralChunk
 */

/**
 * Parse Markdown body text into structural blocks.
 * Ignores heading-like syntax inside fenced code blocks.
 * Supports ATX (# .. ######) and Setext (=== and ---) headings.
 * @param {string} body
 * @returns {MarkdownBlock[]}
 */
export function parseMarkdownBlocks(body) {
  const lines = body.split(/\r?\n/);
  /** @type {MarkdownBlock[]} */
  const blocks = [];
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // 1. Fenced Code Blocks (``` or ~~~)
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
        endLine: i, // 1-indexed end line
      });
      continue;
    }
    
    // 2. ATX Headings (# .. ######)
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
    
    // 3. Setext Headings (Heading text followed by === or ---)
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
    
    // 4. Blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }
    
    // 5. Tables (Lines starting/containing | with header separator)
    if (/^\s*\|/.test(line) || (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1]))) {
      const startLine = lineNum;
      const tableLines = [];
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
    
    // 6. Blockquotes (> ...)
    if (/^\s*>/.test(line)) {
      const startLine = lineNum;
      const bqLines = [];
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
    
    // 7. Generic Paragraph / Block
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

/**
 * Convert token budget to character cap (approx 4 chars/token).
 * @param {number} [tokens]
 * @param {number} [defaultMax=1200]
 * @returns {number}
 */
export function resolveChunkBudget(tokens, defaultMax = 1200) {
  if (tokens && Number.isFinite(tokens) && tokens > 0) {
    return Math.max(100, Math.min(8192, Math.round(tokens * 4)));
  }
  return defaultMax;
}

/**
 * Chunk Markdown blocks structurally with heading context and oversized block continuation.
 * @param {string | MarkdownBlock[]} input
 * @param {number | {maxChunk?:number, targetTokens?:number}} [opts]
 * @returns {StructuralChunk[]}
 */
export function chunkMarkdownStructural(input, opts) {
  const options = typeof opts === 'number' ? { maxChunk: opts } : (opts || {});
  const maxChunk = resolveChunkBudget(options.targetTokens, options.maxChunk ?? 1200);
  const blocks = typeof input === 'string' ? parseMarkdownBlocks(input) : input;
  /** @type {StructuralChunk[]} */
  const chunks = [];
  
  /** @type {{level:number, heading:string}[]} */
  const headingStack = [];
  
  let currentGroup = [];
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
      const subPieces = splitOversizedBlock(blockText, maxChunk);
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

/**
 * Split an oversized block (code fence, table, large paragraph) into bounded pieces.
 * @param {string} text
 * @param {number} maxChunk
 * @returns {string[]}
 */
function splitOversizedBlock(text, maxChunk) {
  const lines = text.split('\n');
  const pieces = [];
  let currentLines = [];
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
      let rest = line;
      while (rest.length > maxChunk) {
        let cut = rest.lastIndexOf(' ', maxChunk);
        if (cut <= 0) cut = maxChunk;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) currentLines.push(rest);
      currentLen = rest.length;
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

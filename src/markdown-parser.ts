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

/**
 * issue #202: script-calibrated token estimate for the sentencepiece E5/BGE
 * vocab family — the fast-path alternative to running the real tokenizer per
 * block. Ratios are calibrated so the estimate errs slightly HIGH: a budget
 * checked against this estimate never overflows the model's real maxTokens.
 *   Latin/digits/punctuation ≈ 4 chars/token, Cyrillic ≈ 1.8 chars/token
 *   (RU systematically under-chunked by the old char budget — the point of
 *   this issue), CJK ≈ 1 token/char, whitespace mostly merges into the
 *   following subword so it counts a little.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04ff) tokens += 0.55; // Cyrillic (+ Cyrillic supplement edges)
    else if (
      (c >= 0x3040 && c <= 0x30ff) || // hiragana / katakana
      (c >= 0x3400 && c <= 0x4dbf) || // CJK ext A
      (c >= 0x4e00 && c <= 0x9fff) || // CJK unified
      (c >= 0xff00 && c <= 0xffef)    // fullwidth forms
    ) {
      tokens += 1.0;
    } else if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) tokens += 0.08;
    else if (c < 0x80) tokens += 0.25; // ASCII (latin, digits, punctuation, markdown syntax)
    else tokens += 0.35; // other scripts / symbols — conservative middle ground
  }
  return Math.ceil(tokens);
}

/** Token measure: injected exact counter when available, else the calibrated estimate. */
export type TokenCounter = (text: string) => number;

export interface ChunkBudget {
  /** Max measured size a single chunk may reach before it is split/flushed. */
  budget: number;
  /** Measures a text in the same unit the budget is expressed in. */
  measure: TokenCounter;
  /** Unit name for diagnostics/tests. */
  unit: 'chars' | 'tokens';
}

/** Char budget (pre-#202 behavior) vs token budget (issue #202). */
export function resolveChunkingBudget(opts: {
  maxChunk?: number;
  maxChunkTokens?: number;
  countTokens?: TokenCounter;
}): ChunkBudget {
  if (opts.maxChunkTokens && Number.isFinite(opts.maxChunkTokens) && opts.maxChunkTokens > 0) {
    const budget = Math.max(32, Math.round(opts.maxChunkTokens));
    return { budget, measure: opts.countTokens ?? estimateTokens, unit: 'tokens' };
  }
  const budget = resolveChunkBudget(undefined, opts.maxChunk ?? 1200);
  return { budget, measure: (t) => t.length, unit: 'chars' };
}

/**
 * issue #202: the DEFAULT chunk budget in tokens, derived from the embedding
 * adapter's context window. Capped at 512 — a passage much larger than that
 * dilutes retrieval granularity even for models with 8k+ context (bge-m3).
 * Returns undefined for adapters without a known maxTokens, which keeps the
 * legacy char budget instead of guessing.
 */
export function defaultChunkTokenBudget(adapter: { maxTokens?: number }): number | undefined {
  const mt = adapter?.maxTokens;
  if (!mt || !Number.isFinite(mt) || mt <= 0) return undefined;
  return Math.min(Math.round(mt), 512);
}

export function chunkMarkdownStructural(
  input: string | MarkdownBlock[],
  opts?: number | { maxChunk?: number; targetTokens?: number; maxChunkTokens?: number; countTokens?: TokenCounter }
): StructuralChunk[] {
  const options = typeof opts === 'number' ? { maxChunk: opts } : (opts || {});
  const { budget: maxChunk, measure } = resolveChunkingBudget(options);
  const blocks = typeof input === 'string' ? parseMarkdownBlocks(input) : input;
  const chunks: StructuralChunk[] = [];

  const headingStack: Array<{ level: number; heading: string }> = [];

  let currentGroup: string[] = [];
  let currentLen = 0;
  let groupStartLine = 0;
  let groupEndLine = 0;
  // measured size of the '\n\n' joiner — 2 in char mode, ~1 in token mode
  const joinerSize = measure('\n\n');

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

    if (measure(blockText) > maxChunk) {
      flushGroup();
      const headingPath = headingStack.map(h => h.heading);
      // Issue #167: pieces carry the block-relative range of REAL source
      // lines backing them — synthetic fence/header repeats must not advance
      // the line cursor, or every later sub-chunk drifts down the file.
      const subPieces = splitOversizedByMeasure(blockText, maxChunk, measure, block.type);
      for (const piece of subPieces) {
        chunks.push({
          heading: headingPath.at(-1) ?? '',
          headingPath: [...headingPath],
          text: piece.text,
          startLine: block.startLine + piece.startLine,
          endLine: Math.min(block.endLine, block.startLine + piece.endLine),
        });
      }
      continue;
    }

    const addedLen = currentLen === 0 ? measure(blockText) : currentLen + joinerSize + measure(blockText);
    if (addedLen > maxChunk && currentGroup.length > 0) {
      flushGroup();
    }

    if (currentGroup.length === 0) {
      groupStartLine = block.startLine;
    }
    currentGroup.push(blockText);
    currentLen += (currentGroup.length === 1 ? 0 : joinerSize) + measure(blockText);
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

export interface OversizedPiece {
  text: string;
  /** 0-based block-relative range of REAL source lines backing this piece. */
  startLine: number;
  endLine: number;
}

export function splitOversizedBlock(
  text: string,
  maxChunk: number,
  blockType?: MarkdownBlock['type']
): string[] {
  return splitOversizedBlockWithRanges(text, maxChunk, blockType).map((p) => p.text);
}

/**
 * issue #202: oversized-block splitting under an arbitrary measure (chars or
 * tokens). The heavy lifting (fence repeats, table header repeats, #167 line
 * ranges) stays in the char-based splitOversizedBlockWithRanges; the token
 * budget is converted to a char budget for THIS block via its own chars-per-
 * measured-unit ratio, then every piece is verified — script-skew inside the
 * block (ASCII header + Cyrillic body) is caught by a greedy re-split.
 */
export function splitOversizedByMeasure(
  text: string,
  budget: number,
  measure: TokenCounter,
  blockType?: MarkdownBlock['type']
): OversizedPiece[] {
  if (measure(text) <= budget) {
    return [{ text, startLine: 0, endLine: Number.MAX_SAFE_INTEGER }];
  }

  // char equivalent of the budget for this block's script mix; fall back to
  // a plain char split with the raw budget when measuring is degenerate
  const measured = Math.max(1, measure(text));
  const charsPerUnit = text.length / measured;
  const charBudget = Math.max(32, Math.floor(budget * charsPerUnit));

  const pieces = splitOversizedBlockWithRanges(text, charBudget, blockType);
  const out: OversizedPiece[] = [];
  for (const piece of pieces) {
    if (measure(piece.text) <= budget) {
      out.push(piece);
      continue;
    }
    // script-skew safety net: greedy line/word accumulation under measure;
    // the greedy splitter tracks consumed source lines so #167 ranges stay real
    const spanLines = piece.endLine - piece.startLine + 1;
    const textLines = piece.text.split('\n');
    // when synthetic lines (fence/table repeats) inflated the piece, the text
    // has more lines than the source span — clamp keeps ranges inside the block
    const lineStride = textLines.length > spanLines ? spanLines / textLines.length : 1;
    for (const sub of greedySplitByMeasure(piece.text, budget, measure)) {
      const startLine = piece.startLine + Math.min(spanLines - 1, Math.floor(sub.startLine * lineStride));
      const endLine = piece.startLine + Math.min(spanLines - 1, Math.max(sub.startLine, Math.floor(sub.endLine * lineStride)));
      out.push({ text: sub.text, startLine, endLine });
    }
  }
  return out;
}

/** Greedy line-based (then word-based, then hard-slice) split under measure, with line ranges. */
interface MeasuredPiece {
  text: string;
  /** 0-based indices into the input's line array. */
  startLine: number;
  endLine: number;
}

function greedySplitByMeasure(text: string, budget: number, measure: TokenCounter): MeasuredPiece[] {
  const out: MeasuredPiece[] = [];
  const lines = text.split('\n');
  let bufStart = 0;
  let bufEnd = 0;
  let current = '';

  const flush = (uptoLine: number) => {
    if (current.trim()) out.push({ text: current.trim(), startLine: bufStart, endLine: uptoLine });
    current = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const candidate = current ? `${current}\n${line}` : line;
    if (measure(candidate) <= budget) {
      if (!current) bufStart = i;
      current = candidate;
      bufEnd = i;
      continue;
    }
    flush(i - 1);
    if (measure(line) <= budget) {
      bufStart = i;
      current = line;
      bufEnd = i;
      continue;
    }
    // single line over budget: word-level accumulation, all pieces stay on
    // this line's range
    const words = line.split(/\s+/);
    let wordBuf = '';
    for (const word of words) {
      const wc = wordBuf ? `${wordBuf} ${word}` : word;
      if (measure(wc) <= budget) {
        wordBuf = wc;
        continue;
      }
      if (wordBuf.trim()) out.push({ text: wordBuf.trim(), startLine: i, endLine: i });
      if (measure(word) <= budget) {
        wordBuf = word;
        continue;
      }
      // monster token (no spaces): hard-slice by chars proportional to budget
      const ratio = line.length / Math.max(1, measure(line));
      const sliceLen = Math.max(8, Math.floor(budget * ratio));
      let rest = word;
      while (measure(rest) > budget && rest.length > sliceLen) {
        out.push({ text: rest.slice(0, sliceLen), startLine: i, endLine: i });
        rest = rest.slice(sliceLen);
      }
      wordBuf = rest;
    }
    if (wordBuf.trim()) {
      bufStart = i;
      current = wordBuf;
      bufEnd = i;
    }
  }
  flush(bufEnd);
  return out;
}

/**
 * Issue #167: like splitOversizedBlock, but each piece also reports the
 * block-relative range of source lines it was built from. Synthetic lines
 * added to keep pieces self-contained (fence repeats, table header repeats)
 * do NOT count — only the first piece's opening fence/header and a real
 * closing fence belong to the source.
 */
export function splitOversizedBlockWithRanges(
  text: string,
  maxChunk: number,
  blockType?: MarkdownBlock['type']
): OversizedPiece[] {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return splitLongLine(text, maxChunk).map((piece) => ({ text: piece, startLine: 0, endLine: 0 }));
  }

  // If code block with opening fence
  if (blockType === 'code' && lines.length > 2 && /^(\s*)(`{3,}|~{3,})/.test(lines[0])) {
    const openFence = lines[0];
    const hasCloseFence = /^(\s*)(`{3,}|~{3,})/.test(lines[lines.length - 1]);
    const closeFence = hasCloseFence ? lines[lines.length - 1] : '```';
    const innerLines = lines.slice(1, hasCloseFence ? lines.length - 1 : lines.length);

    const pieces: OversizedPiece[] = [];
    let currentCode: Array<{ line: string; srcIdx: number }> = [];
    let currentLen = openFence.length + closeFence.length + 2;

    // The opening fence is a real source line only in the first piece; a
    // real closing fence only in the final one.
    const flush = (isFinal: boolean) => {
      const firstReal = pieces.length === 0 ? 0 : currentCode[0].srcIdx;
      const lastReal = isFinal && hasCloseFence ? lines.length - 1 : currentCode[currentCode.length - 1].srcIdx;
      pieces.push({
        text: [openFence, ...currentCode.map((c) => c.line), closeFence].join('\n'),
        startLine: firstReal,
        endLine: lastReal,
      });
    };

    for (let offset = 0; offset < innerLines.length; offset++) {
      const line = innerLines[offset];
      const srcIdx = 1 + offset;
      if (currentLen + line.length + 1 > maxChunk && currentCode.length > 0) {
        flush(false);
        currentCode = [];
        currentLen = openFence.length + closeFence.length + 2;
      }
      currentCode.push({ line, srcIdx });
      currentLen += line.length + 1;
    }
    if (currentCode.length > 0) {
      flush(true);
    }
    if (pieces.length > 0) return pieces;
  }

  // If table with header + separator rows
  if (blockType === 'table' && lines.length > 2 && /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[1])) {
    const headerRows = [lines[0], lines[1]];
    const dataRows = lines.slice(2);
    const headerLen = headerRows[0].length + headerRows[1].length + 2;

    const pieces: OversizedPiece[] = [];
    let currentRows: Array<{ row: string; srcIdx: number }> = [];
    let currentLen = headerLen;

    const flush = () => {
      const firstReal = pieces.length === 0 ? 0 : currentRows[0].srcIdx;
      pieces.push({
        text: [...headerRows, ...currentRows.map((r) => r.row)].join('\n'),
        startLine: firstReal,
        endLine: currentRows[currentRows.length - 1].srcIdx,
      });
    };

    for (let offset = 0; offset < dataRows.length; offset++) {
      const row = dataRows[offset];
      const srcIdx = 2 + offset;
      if (currentLen + row.length + 1 > maxChunk && currentRows.length > 0) {
        flush();
        currentRows = [];
        currentLen = headerLen;
      }
      currentRows.push({ row, srcIdx });
      currentLen += row.length + 1;
    }
    if (currentRows.length > 0) {
      flush();
    }
    if (pieces.length > 0) return pieces;
  }

  // Standard paragraph/list splitting
  const pieces: OversizedPiece[] = [];
  let currentLines: Array<{ line: string; srcIdx: number }> = [];
  let currentLen = 0;

  const flush = () => {
    pieces.push({
      text: currentLines.map((l) => l.line).join('\n').trim(),
      startLine: currentLines[0].srcIdx,
      endLine: currentLines[currentLines.length - 1].srcIdx,
    });
  };

  for (let srcIdx = 0; srcIdx < lines.length; srcIdx++) {
    const line = lines[srcIdx];
    if (currentLen + line.length + 1 > maxChunk && currentLines.length > 0) {
      flush();
      currentLines = [];
      currentLen = 0;
    }

    if (line.length > maxChunk) {
      if (currentLines.length > 0) {
        flush();
        currentLines = [];
      }
      for (const piece of splitLongLine(line, maxChunk)) {
        pieces.push({ text: piece, startLine: srcIdx, endLine: srcIdx });
      }
      currentLen = 0;
      continue;
    }

    currentLines.push({ line, srcIdx });
    currentLen += line.length + 1;
  }

  if (currentLines.length > 0) {
    flush();
  }

  return pieces;
}


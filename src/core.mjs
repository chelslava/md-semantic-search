// @ts-check
/**
 * Core helpers: model loading, embeddings, markdown walking + chunking, cosine.
 * Fully model- and path-agnostic — everything is driven by explicit arguments
 * so the same code works on any folder of .md files, anywhere on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveModel } from './models.mjs';

const _extractors = new Map();

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} id - HF repo id (e.g. "Xenova/multilingual-e5-base")
 * @property {string} [revision] - pinned revision (default "main")
 * @property {number} [dim] - embedding dimension (0 for custom ids)
 * @property {string} [queryPrefix] - E5-style "query: " prefix ('' for bge)
 * @property {string} [passagePrefix] - E5-style "passage: " prefix ('' for bge)
 * @property {string} [note] - human-readable description
 */

/**
 * Lazily load (and cache) a feature-extraction pipeline for a model.
 * @param {ModelDescriptor} model - descriptor from resolveModel()
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 */
export async function getExtractor(model, cacheDir, offline = false) {
  const key = `${model.id}@${model.revision || 'main'}|${offline ? 'off' : 'on'}`;
  if (_extractors.has(key)) return _extractors.get(key);
  const { pipeline, env } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  env.allowRemoteModels = !offline;
  // Prefer the quantized (q8) weights when the model repo ships them — this is
  // what Xenova/* repos do (e5-base: ~280MB vs ~1.1GB fp32). Without this the
  // v4 default dtype (fp32 on Node) would download the 4x larger weights.
  const ext = await pipeline('feature-extraction', model.id, {
    revision: model.revision || 'main',
    dtype: 'q8',
  });
  _extractors.set(key, ext);
  return ext;
}

/**
 * Embed texts with the given model descriptor.
 * @param {string[]} texts
 * @param {'query'|'passage'} kind
 * @param {ModelDescriptor} model - descriptor from resolveModel()
 * @param {string} cacheDir
 * @param {boolean} [offline=false] - never touch the network; require a cached model
 * @returns {Promise<number[][]>} L2-normalized vectors
 */
export async function embed(texts, kind, model, cacheDir, offline = false) {
  const ext = await getExtractor(model, cacheDir, offline);
  const prefix = kind === 'query' ? model.queryPrefix : model.passagePrefix;
  const input = prefix ? texts.map(t => prefix + t) : texts;
  const out = await ext(input, { pooling: 'mean', normalize: true });
  return out.tolist();
}

/** Cosine similarity for L2-normalized vectors == dot product. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Encode a numeric vector as a base64 string of its Float32Array bytes
 * (binary vector storage, issue #4). ~4× smaller than decimal JSON: a 768-dim
 * vector is 3072 raw bytes → 4096 base64 chars, vs ~8-10 chars per number.
 * @param {number[]|Float32Array} vec
 * @returns {string}
 */
export function encodeVec(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/**
 * Decode a base64 vector string back to a Float32Array (binary storage, #4).
 * @param {string} s
 * @returns {Float32Array}
 */
export function decodeVec(s) {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * True when the index uses the binary vector format (vec stored as base64).
 * @param {{format?:string}} index - parsed vectors.json
 * @returns {boolean}
 */
export function isBinaryIndex(index) {
  return index.format === 'binary-v1';
}

/** Recursively collect .md/.markdown files under dir, honoring ignore globs. */
export function walkMarkdown(dir, ignore = []) {
  const out = [];
  const ignoreRe = ignore.map(globToRegExp);
  const walk = (cur) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.name.startsWith('.')) continue; // skip dotfiles/dotdirs (.git, .mdss…)
      if (ignoreRe.some(re => re.test(rel) || re.test(e.name))) continue;
      if (e.isDirectory()) walk(full);
      else if (/\.(md|markdown)$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Minimal glob → RegExp (supports * and **). */
export function globToRegExp(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')      // placeholder for **
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

/** Strip YAML frontmatter → { frontmatter, body }. */
export function splitFrontmatter(raw) {
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      return {
        frontmatter: raw.slice(3, end).trim(),
        body: raw.slice(end + 4).replace(/^\s*\n/, ''),
      };
    }
  }
  return { frontmatter: '', body: raw };
}

export function extractTitle(frontmatter, body, relPath) {
  const fmTitle = frontmatter.match(/^title:\s*(.+)$/m);
  if (fmTitle) return fmTitle[1].trim().replace(/^["']|["']$/g, '');
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(relPath).replace(/\.(md|markdown)$/i, '');
}

const DEFAULT_MAX_CHUNK = 1400; // chars; ~350-450 tokens, fits e5/bge context

/**
 * Chunk markdown by headings; oversized sections split further on blank lines.
 * @returns {{heading:string, text:string}[]}
 */
export function chunkMarkdown(body, maxChunk = DEFAULT_MAX_CHUNK) {
  const lines = body.split('\n');
  const sections = [];
  let curHeading = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading: curHeading, text });
    buf = [];
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flush(); curHeading = h[2].trim(); }
    else buf.push(line);
  }
  flush();

  const chunks = [];
  for (const sec of sections) {
    if (sec.text.length <= maxChunk) { chunks.push(sec); continue; }
    const paras = sec.text.split(/\n\s*\n/);
    let acc = '';
    const emit = () => { if (acc.trim()) chunks.push({ heading: sec.heading, text: acc.trim() }); };
    for (const p of paras) {
      if (p.length > maxChunk) {
        // A single unbroken paragraph exceeds the cap (tables, logs, code):
        // flush what's accumulated, then hard-wrap the paragraph on its own
        // so every emitted chunk is within maxChunk (issue #24).
        emit();
        for (const piece of hardWrap(p, maxChunk)) {
          chunks.push({ heading: sec.heading, text: piece });
        }
        acc = '';
        continue;
      }
      if ((acc + '\n\n' + p).length > maxChunk && acc) {
        emit();
        acc = p;
      } else {
        acc = acc ? acc + '\n\n' + p : p;
      }
    }
    emit();
  }
  return chunks.filter(c => c.text.replace(/\s/g, '').length >= 24);
}

/**
 * Split one over-long paragraph into pieces of at most `maxChunk` chars,
 * preferring word boundaries (spaces) over hard character cuts.
 * @param {string} text
 * @param {number} maxChunk
 * @returns {string[]}
 */
function hardWrap(text, maxChunk) {
  const out = [];
  let rest = text;
  while (rest.length > maxChunk) {
    let cut = rest.lastIndexOf(' ', maxChunk);
    if (cut <= 0) cut = maxChunk; // no space in window → hard cut mid-word
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Parse one file into title + chunk records (no embeddings yet).
 * @param {string} absPath - absolute file path
 * @param {string} dbDir - base dir (for relative file labels)
 * @param {number} [maxChunk] - chunk size cap (defaults to DEFAULT_MAX_CHUNK)
 * @param {string} [raw] - already-read file content. When given, the file is
 *   NOT read from disk again (issue #35: buildIndex already read it for the
 *   md5 fast-path check, so a changed file was being read twice).
 * @returns {{file:string, title:string, heading:string, text:string}[]}
 */
export function parseFile(absPath, dbDir, maxChunk, raw) {
  const content = raw ?? fs.readFileSync(absPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(content);
  const rel = path.relative(dbDir, absPath).split(path.sep).join('/');
  const title = extractTitle(frontmatter, body, rel);
  return chunkMarkdown(body, maxChunk).map(c => ({
    file: rel,
    title,
    heading: c.heading,
    text: c.text,
  }));
}

export { resolveModel };

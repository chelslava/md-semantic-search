/**
 * Build / refresh the semantic index for a folder of markdown files.
 * Incremental at TWO levels:
 *   1. per-file md5  -> completely unchanged files reuse their chunks as-is;
 *   2. per-chunk hash (chunkHash = SHA-256 of the exact passage input that
 *      goes to embed()) -> inside a *changed* file, sections whose embedding
 *      input is unchanged reuse their stored vector, so an append/edit in one
 *      place of a long file no longer re-embeds all of its sections.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkMarkdown, parseFile, embed, resolveModel } from './core.mjs';

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const loadJSON = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
};

/** Normalize text for stable hashing across runs: CRLF -> LF, trim edges. */
function normalize(s) {
  return (s ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Stable per-chunk hash: SHA-256 over the exact passage input that is passed
 * to embed() (`title\nheading\ntext`) plus the model identity and its passage
 * prefix. Because the model participates in the key, switching models
 * invalidates every chunk (full rebuild) - by design. CRLF/whitespace-only
 * edits of a section do NOT change its hash, so its vector is reused.
 * @param {{id:string, passagePrefix?:string}} model - resolved model descriptor
 * @param {string} modelName - alias or id as passed on the CLI
 * @param {{title:string, heading:string, text:string}} chunk
 */
export function chunkHash(model, modelName, chunk) {
  const input = [
    model.id,
    modelName || '',
    model.passagePrefix || '',
    normalize(chunk.title),
    normalize(chunk.heading),
    normalize(chunk.text),
  ].join('\u0000');
  return sha256(input);
}

/**
 * @param {object} opts
 * @param {string} opts.db        - base dir of .md files (absolute)
 * @param {string} opts.indexDir  - where vectors.json / .hashes.json live
 * @param {string} opts.cacheDir  - model cache dir
 * @param {string} opts.modelName - model alias or id
 * @param {string[]} opts.ignore  - glob patterns to skip
 * @param {(s:string)=>void} [opts.log]
 */
export async function buildIndex(opts) {
  const { db, indexDir, cacheDir, modelName, ignore = [], log = () => {} } = opts;
  const model = resolveModel(modelName);
  const vectorsPath = path.join(indexDir, 'vectors.json');
  const hashesPath = path.join(indexDir, '.hashes.json');

  fs.mkdirSync(indexDir, { recursive: true });

  const files = walkMarkdown(db, ignore);
  const oldHashes = loadJSON(hashesPath, {});
  const oldIndex = loadJSON(vectorsPath, { chunks: [], model: null });

  // If the model changed, all stored vectors are incompatible → full rebuild.
  const modelChanged = oldIndex.model && oldIndex.model !== model.id;

  const oldByFile = new Map();
  // chunk-level cache: hash of the passage input -> stored vector. Built from
  // the OLD index so changed files can reuse vectors of unchanged sections.
  // Old chunks (from a pre-chunkHash index) get their hash computed the same
  // way, so reuse works even on the first run after an upgrade.
  const vecByChunkHash = new Map();
  if (!modelChanged) {
    for (const c of oldIndex.chunks) {
      if (!oldByFile.has(c.file)) oldByFile.set(c.file, []);
      oldByFile.get(c.file).push(c);
      const key = c.chunkHash || chunkHash(model, modelName, c);
      if (c.vec) vecByChunkHash.set(key, c.vec);
    }
  }

  const newHashes = {};
  const chunks = [];
  const toEmbed = [];
  let reused = 0, reusedChunks = 0, changedFiles = 0;

  for (const abs of files) {
    const raw = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(db, abs).split(path.sep).join('/');
    const h = md5(raw);
    newHashes[rel] = h;

    if (!modelChanged && oldHashes[rel] === h && oldByFile.has(rel)) {
      const old = oldByFile.get(rel);
      // Backfill chunkHash for chunks that predate the chunk-level cache, so
      // the persisted index is self-contained and no recompute is needed later.
      for (const c of old) {
        if (!c.chunkHash) c.chunkHash = chunkHash(model, modelName, c);
      }
      chunks.push(...old);
      reused += old.length;
      continue;
    }
    changedFiles++;
    const parsed = parseFile(abs, db);
    for (const c of parsed) {
      const key = chunkHash(model, modelName, c);
      const cached = vecByChunkHash.get(key);
      if (cached) {
        c.vec = cached;
        c.chunkHash = key;
        reused++;
        reusedChunks++;
      } else {
        c.chunkHash = key;
        toEmbed.push(c);
      }
      chunks.push(c);
    }
  }

  if (toEmbed.length > 0) {
    log(`Embedding ${toEmbed.length} chunks from ${changedFiles} changed file(s) ` +
        `with ${model.id}...`);
    const BATCH = 32;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const slice = toEmbed.slice(i, i + BATCH);
      const vecs = await embed(
        slice.map(c => `${c.title}\n${c.heading}\n${c.text}`),
        'passage', model, cacheDir,
      );
      slice.forEach((c, j) => { c.vec = vecs[j]; });
      log(`  ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`);
    }
  }

  const dim = chunks[0]?.vec?.length ?? model.dim ?? 0;
  const index = {
    model: model.id,
    modelAlias: modelName || 'e5-base',
    dim,
    db,
    built: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };

  fs.writeFileSync(vectorsPath, JSON.stringify(index));
  fs.writeFileSync(hashesPath, JSON.stringify(newHashes, null, 2));

  return {
    files: files.length,
    chunks: chunks.length,
    reused,
    reusedChunks,
    reusedFiles: reused - reusedChunks, // via the file-level fast path
    embedded: toEmbed.length,
    dim,
    model: model.id,
    vectorsPath,
  };
}

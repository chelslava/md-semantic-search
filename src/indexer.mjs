/**
 * Build / refresh the semantic index for a folder of markdown files.
 * Incremental: per-file md5; unchanged files reuse their stored embeddings.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkMarkdown, parseFile, embed, resolveModel } from './core.mjs';

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const loadJSON = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
};

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
  if (!modelChanged) {
    for (const c of oldIndex.chunks) {
      if (!oldByFile.has(c.file)) oldByFile.set(c.file, []);
      oldByFile.get(c.file).push(c);
    }
  }

  const newHashes = {};
  const chunks = [];
  const toEmbed = [];
  let reused = 0, changedFiles = 0;

  for (const abs of files) {
    const raw = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(db, abs).split(path.sep).join('/');
    const h = md5(raw);
    newHashes[rel] = h;

    if (!modelChanged && oldHashes[rel] === h && oldByFile.has(rel)) {
      const old = oldByFile.get(rel);
      chunks.push(...old);
      reused += old.length;
      continue;
    }
    changedFiles++;
    const parsed = parseFile(abs, db);
    for (const c of parsed) { chunks.push(c); toEmbed.push(c); }
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
    embedded: toEmbed.length,
    dim,
    model: model.id,
    vectorsPath,
  };
}

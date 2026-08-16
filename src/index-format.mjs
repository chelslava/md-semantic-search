// @ts-check
import { decodeVec, parseSchemaVersion, resolveIndexDimension, SCHEMA_VERSION } from './core.mjs';
import { validateLexicalIndex } from './lexical.mjs';
import { resolveModel } from './models.mjs';

const REBUILD = ' — run `mdss index` to rebuild';

/** @param {unknown} value @param {string} location */
export function inspectIndexSchema(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} root must be an object${REBUILD}`);
  }
  const index = /** @type {Record<string, unknown>} */ (value);
  return { index, schema: parseSchemaVersion(index.schemaVersion) };
}

/** @param {unknown} value @param {number|undefined} expectedDim @param {string} where */
export function validateNumericVector(value, expectedDim, where) {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error(`${where}: missing vector${REBUILD}`);
  }
  if (value.length === 0) throw new Error(`${where}: vector must not be empty${REBUILD}`);
  if (expectedDim !== undefined && value.length !== expectedDim) {
    throw new Error(`${where}: vector has ${value.length} dims, expected ${expectedDim}${REBUILD}`);
  }
  for (let position = 0; position < value.length; position++) {
    if (Array.isArray(value) && !Object.hasOwn(value, position)) {
      throw new Error(`${where}: missing vector component at ${position}${REBUILD}`);
    }
    if (typeof value[position] !== 'number' || !Number.isFinite(value[position])) {
      throw new Error(`${where}: non-finite vector value${REBUILD}`);
    }
  }
  return value.length;
}

/** @param {unknown} chunk @param {number} position @param {{dim:number|undefined, encoding:'stored'|'loaded'|'none', allowMissingVector:(boolean|undefined)}} options */
export function validateCurrentChunk(chunk, position, options) {
  const prefix = `chunk ${position}`;
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new Error(`${prefix} must be an object${REBUILD}`);
  }
  const value = /** @type {Record<string, unknown>} */ (chunk);
  for (const field of ['file', 'title', 'heading', 'text', 'chunkHash']) {
    if (typeof value[field] !== 'string') {
      throw new Error(`${prefix} ${field} must be a string${REBUILD}`);
    }
  }
  if (!Array.isArray(value.headingPath) || value.headingPath.length === 0) {
    throw new Error(`${prefix} headingPath must contain nonempty strings${REBUILD}`);
  }
  for (let pathPosition = 0; pathPosition < value.headingPath.length; pathPosition++) {
    if (!Object.hasOwn(value.headingPath, pathPosition) ||
        typeof value.headingPath[pathPosition] !== 'string' ||
        value.headingPath[pathPosition].trim().length === 0) {
      throw new Error(`${prefix} headingPath must contain nonempty strings${REBUILD}`);
    }
  }
  if (value.headingPath[value.headingPath.length - 1] !== value.heading) {
    throw new Error(`${prefix} headingPath leaf must equal heading${REBUILD}`);
  }
  if (options.encoding === 'none') return;
  const vectorWhere = `${prefix}; chunk ${value.file}` +
    (value.heading ? ` › ${value.heading}` : '');
  if (value.vec === undefined && options.allowMissingVector) return;
  if (options.encoding === 'stored') {
    if (typeof value.vec !== 'string') {
      throw new Error(`${prefix} vec must be canonical base64${REBUILD}`);
    }
    try {
      decodeVec(value.vec, options.dim);
    } catch (error) {
      throw new Error(`${vectorWhere}: ${error.message}`, { cause: error });
    }
    return;
  }
  validateNumericVector(value.vec, options.dim, vectorWhere);
}

/**
 * Shared vectors.json boundary for loader, diagnostics, stats, and recovery.
 * Legacy schemas intentionally keep their historical loose chunk metadata.
 * @param {unknown} value
 * @param {string} location
 * @param {{encoding?:'stored'|'loaded', validateVectors?:boolean,
 *   allowMissingVectors?:boolean, validateLexical?:boolean}} [options]
 */
export function validateIndexEnvelope(value, location, options = {}) {
  const { index, schema } = inspectIndexSchema(value, location);
  if (schema > SCHEMA_VERSION) {
    throw new Error(`${location} uses schema v${schema}, newer than this mdss supports; ` +
      `supports up to v${SCHEMA_VERSION} — upgrade md-semantic-search`);
  }
  if (!Array.isArray(index.chunks)) {
    throw new Error(`${location} chunks must be an array${REBUILD}`);
  }
  let modelName = index.model ?? index.modelAlias;
  if (schema >= 3) {
    if (typeof index.model !== 'string' || index.model.trim().length === 0) {
      throw new Error(`schema v3 model must be a nonempty string${REBUILD}`);
    }
    modelName = index.model;
  } else if (modelName !== undefined && modelName !== null && typeof modelName !== 'string') {
    throw new Error(`${location} model metadata must be a string${REBUILD}`);
  }
  const model = resolveModel(/** @type {string|undefined} */ (modelName ?? undefined));
  const dim = resolveIndexDimension(index.dim, model.dim);
  if (schema < 3) {
    return { index, schema, model, dim };
  }
  if (index.format !== 'binary-v1') {
    throw new Error(`schema v3 format must be binary-v1${REBUILD}`);
  }
  if (typeof index.chunkCount !== 'number' || !Number.isSafeInteger(index.chunkCount) || index.chunkCount < 0 ||
      index.chunkCount !== index.chunks.length) {
    throw new Error(`schema v3 chunkCount must equal chunks.length${REBUILD}`);
  }
  if (index.chunks.length > 0 && dim === undefined) {
    throw new Error(`nonempty schema v3 custom index requires explicit dim${REBUILD}`);
  }
  const encoding = options.validateVectors === false ? 'none' : (options.encoding ?? 'stored');
  for (let position = 0; position < index.chunks.length; position++) {
    validateCurrentChunk(index.chunks[position], position, {
      dim, encoding, allowMissingVector: options.allowMissingVectors,
    });
  }
  if (options.validateLexical !== false) {
    const lexicalError = validateLexicalIndex(index.lexical, index.chunks.length);
    if (lexicalError) {
      throw new Error(`schema v3 lexical index is invalid (${lexicalError})${REBUILD}`);
    }
  }
  return { index, schema, model, dim };
}

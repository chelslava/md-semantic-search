import { decodeVec, parseSchemaVersion, resolveIndexDimension, SCHEMA_VERSION } from './core.js';
import { validateLexicalIndex } from './lexical.js';
import { resolveModel, ModelAdapter } from './models.js';

const REBUILD = ' — run `mdss index` to rebuild';

export function inspectIndexSchema(value: unknown, location: string): { index: Record<string, unknown>; schema: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} root must be an object${REBUILD}`);
  }
  const index = value as Record<string, unknown>;
  return { index, schema: parseSchemaVersion(index.schemaVersion) };
}

export function validateNumericVector(value: unknown, expectedDim: number | undefined, where: string): number {
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error(`${where}: missing vector${REBUILD}`);
  }
  const vec = value as ArrayLike<number>;
  if (vec.length === 0) throw new Error(`${where}: vector must not be empty${REBUILD}`);
  if (expectedDim !== undefined && vec.length !== expectedDim) {
    throw new Error(`${where}: vector has ${vec.length} dims, expected ${expectedDim}${REBUILD}`);
  }
  for (let position = 0; position < vec.length; position++) {
    if (Array.isArray(value) && !Object.hasOwn(value, position)) {
      throw new Error(`${where}: missing vector component at ${position}${REBUILD}`);
    }
    if (typeof vec[position] !== 'number' || !Number.isFinite(vec[position])) {
      throw new Error(`${where}: non-finite vector value${REBUILD}`);
    }
  }
  return vec.length;
}

export function validateCurrentChunk(
  chunk: unknown,
  position: number,
  options: { dim: number | undefined; encoding: 'stored' | 'loaded' | 'none'; allowMissingVector?: boolean }
): void {
  const prefix = `chunk ${position}`;
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new Error(`${prefix} must be an object${REBUILD}`);
  }
  const value = chunk as Record<string, any>;
  for (const field of ['file', 'title', 'heading', 'text', 'chunkHash']) {
    if (typeof value[field] !== 'string') {
      throw new Error(`${prefix} ${field} must be a string${REBUILD}`);
    }
  }
  if (!Array.isArray(value.headingPath) || value.headingPath.length === 0) {
    throw new Error(`${prefix} headingPath must contain nonempty strings${REBUILD}`);
  }
  for (let pathPosition = 0; pathPosition < value.headingPath.length; pathPosition++) {
    if (
      !Object.hasOwn(value.headingPath, pathPosition) ||
      typeof value.headingPath[pathPosition] !== 'string' ||
      value.headingPath[pathPosition].trim().length === 0
    ) {
      throw new Error(`${prefix} headingPath must contain nonempty strings${REBUILD}`);
    }
  }
  if (value.headingPath[value.headingPath.length - 1] !== value.heading) {
    throw new Error(`${prefix} headingPath leaf must equal heading${REBUILD}`);
  }
  if (options.encoding === 'none') return;
  const vectorWhere = `${prefix}; chunk ${value.file}` + (value.heading ? ` › ${value.heading}` : '');
  if (value.vec === undefined && options.allowMissingVector) return;
  if (options.encoding === 'stored') {
    if (typeof value.vec !== 'string') {
      throw new Error(`${prefix} vec must be canonical base64${REBUILD}`);
    }
    try {
      decodeVec(value.vec, options.dim);
    } catch (error: any) {
      throw new Error(`${vectorWhere}: ${error.message}`, { cause: error });
    }
    return;
  }
  validateNumericVector(value.vec, options.dim, vectorWhere);
}

export interface ValidatedIndexEnvelope {
  index: Record<string, any>;
  schema: number;
  model: ModelAdapter;
  dim: number | undefined;
}

export function validateIndexEnvelope(
  value: unknown,
  location: string,
  options: {
    encoding?: 'stored' | 'loaded';
    validateVectors?: boolean;
    allowMissingVectors?: boolean;
    validateLexical?: boolean;
  } = {}
): ValidatedIndexEnvelope {
  const { index, schema } = inspectIndexSchema(value, location);
  if (schema > SCHEMA_VERSION) {
    throw new Error(
      `${location} uses schema v${schema}, newer than this mdss supports; supports up to v${SCHEMA_VERSION} — upgrade md-semantic-search`
    );
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
  const model = resolveModel(modelName as string | undefined);
  const dim = resolveIndexDimension(index.dim, model.dim);
  if (schema < 3) {
    return { index, schema, model, dim };
  }
  if (index.format !== 'binary-v1') {
    throw new Error(`schema v3 format must be binary-v1${REBUILD}`);
  }
  if (
    typeof index.chunkCount !== 'number' ||
    !Number.isSafeInteger(index.chunkCount) ||
    index.chunkCount < 0 ||
    index.chunkCount !== index.chunks.length
  ) {
    throw new Error(`schema v3 chunkCount must equal chunks.length${REBUILD}`);
  }
  if (index.chunks.length > 0 && dim === undefined) {
    throw new Error(`nonempty schema v3 custom index requires explicit dim${REBUILD}`);
  }
  const encoding = options.validateVectors === false ? 'none' : (options.encoding ?? 'stored');
  for (let position = 0; position < index.chunks.length; position++) {
    validateCurrentChunk(index.chunks[position], position, {
      dim,
      encoding,
      allowMissingVector: options.allowMissingVectors,
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

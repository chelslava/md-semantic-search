/**
 * Core helpers: model loading, embeddings, markdown walking + chunking, cosine.
 * Fully model- and path-agnostic — everything is driven by explicit arguments
 * so the same code works on any folder of .md files, anywhere on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModel, ModelAdapter, Pooling, DType } from './models.js';
import { chunkMarkdownStructural, PARSER_VERSION, StructuralChunk } from './markdown-parser.js';
import { parseFrontmatter, DocumentMetadata } from './frontmatter.js';
import { asymmetricCosineInt8 } from './quantization.js';

export { PARSER_VERSION, parseFrontmatter, resolveModel, DocumentMetadata, ModelAdapter, Pooling, DType, asymmetricCosineInt8 };

const _extractors = new Map<string, any>();

export const LOCK_FILENAME = '.mdss.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

export function pidAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

export interface LockInfo {
  pid: number;
  since: string;
}

function readLock(lockPath: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw);
    if (!Number.isInteger(j.pid) || typeof j.since !== 'string') return null;
    return j as LockInfo;
  } catch {
    return null;
  }
}

export type LockAcquireResult =
  | { acquired: true; lockPath: string }
  | { acquired: false; reason: string; pid: number | null; heldSince: string | null };

export function acquireIndexLock(indexDir: string): LockAcquireResult {
  const lockPath = path.join(indexDir, LOCK_FILENAME);
  const payload = JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, payload);
      return { acquired: true, lockPath };
    } catch (e: any) {
      if (e.code !== 'EEXIST') {
        throw new Error(`cannot create index lock ${lockPath}: ${e.message}`, { cause: e });
      }
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(lockPath);
      } catch {
        /* raced */
      }
      const info = readLock(lockPath);
      const pid = info?.pid ?? null;
      const heldSince = info?.since ?? null;
      const garbage = info === null;
      const dead = pid !== null && !pidAlive(pid);
      const staleMs = stat ? Date.now() - stat.mtimeMs : 0;
      if ((garbage || dead || staleMs > LOCK_STALE_MS) && stat) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced */
        }
        continue;
      }
      return {
        acquired: false,
        reason: garbage
          ? 'lock file is unreadable/abandoned'
          : dead
          ? `lock held by dead pid ${pid} (since ${heldSince})`
          : `index is being written by pid ${pid ?? '?'} (since ${heldSince ?? 'unknown'})`,
        pid,
        heldSince,
      };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* closed */
        }
      }
    }
  }
  return { acquired: false, reason: 'lock reclaimed by another process during retry', pid: null, heldSince: null };
}

export function releaseIndexLock(indexDir: string): void {
  try {
    fs.unlinkSync(path.join(indexDir, LOCK_FILENAME));
  } catch {
    /* ignore */
  }
}

export async function withIndexLock<T>(indexDir: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(indexDir, { recursive: true });
  const r = acquireIndexLock(indexDir);
  if (!r.acquired) throw new Error((r as { reason: string }).reason);
  try {
    return await fn();
  } finally {
    releaseIndexLock(indexDir);
  }
}

export type ModelDescriptor = ModelAdapter;

export function getPipelineModelSource(model: ModelDescriptor, cacheDir: string, offline: boolean): string {
  const revision = model.revision || 'main';
  return offline && revision !== 'main' ? path.join(cacheDir, model.id, revision) : model.id;
}

export function resolveSessionOptions(model?: ModelDescriptor): Record<string, unknown> | undefined {
  const envIntra = process.env.MDSS_INTRA_OP_THREADS || process.env.MDSS_NUM_THREADS;
  const envInter = process.env.MDSS_INTER_OP_THREADS;
  const intra = envIntra ? parseInt(envIntra, 10) : undefined;
  const inter = envInter ? parseInt(envInter, 10) : undefined;
  const opts = model?.sessionOptions || {};
  const intraOpNumThreads = Number.isSafeInteger(intra) && intra && intra > 0 ? intra : (opts.intraOpNumThreads as number | undefined);
  const interOpNumThreads = Number.isSafeInteger(inter) && inter && inter > 0 ? inter : (opts.interOpNumThreads as number | undefined);

  if (intraOpNumThreads === undefined && interOpNumThreads === undefined) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (intraOpNumThreads !== undefined) result.intraOpNumThreads = intraOpNumThreads;
  if (interOpNumThreads !== undefined) result.interOpNumThreads = interOpNumThreads;
  return result;
}

export function getExtractorCacheKey(model: ModelDescriptor, cacheDir: string, offline?: boolean): string {
  const revision = model.revision || 'main';
  const source = getPipelineModelSource(model, cacheDir, !!offline);
  const sessionOptions = resolveSessionOptions(model);
  const sessionKey = sessionOptions ? JSON.stringify(sessionOptions) : 'default';
  return `${model.id}@${revision}|${offline ? 'off' : 'on'}|${source}|${sessionKey}`;
}

export function isNetworkError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'FETCH_ERROR'].includes(code)) {
    return true;
  }
  if (err.name === 'FetchError') return true;
  const status = err.status || err.statusCode || err.cause?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network error') ||
    msg.includes('503 service unavailable') ||
    msg.includes('502 bad gateway') ||
    msg.includes('504 gateway timeout')
  );
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {}
): Promise<T> {
  const maxRetries = Number.isInteger(opts.maxRetries) && opts.maxRetries! >= 0 ? opts.maxRetries! : 3;
  const delays = opts.delays || [1000, 4000, 16000];
  const log = opts.log || (() => {});

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt >= maxRetries || !isNetworkError(err)) {
        if (attempt > 0 && isNetworkError(err)) {
          throw new Error(
            `model download failed after ${attempt} attempts — check network or use --offline (${err.message})`,
            { cause: err }
          );
        }
        throw err;
      }
      attempt++;
      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1] ?? 1000;
      log(`retrying model download (attempt ${attempt}/${maxRetries}) after ${delayMs}ms…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function getExtractor(
  model: ModelDescriptor,
  cacheDir: string,
  offline: boolean = false,
  retryOpts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {}
): Promise<any> {
  if (model.unknownAdapter === true) {
    throw new Error(
      `model "${model.id}" is not a registered adapter and has no explicit ` +
        'configuration, so it cannot embed safely (no E5 prefixes / pooling are ' +
        'guessed). Register it in MODELS or pass an explicit adapter descriptor ' +
        '(see README "How to add a model") — e.g. for a raw id, supply ' +
        'queryPrefix/passagePrefix/dim/pooling explicitly.'
    );
  }
  const revision = model.revision || 'main';
  const source = getPipelineModelSource(model, cacheDir, offline);
  const key = getExtractorCacheKey(model, cacheDir, offline);
  if (_extractors.has(key)) return _extractors.get(key);

  const loadPipeline = async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (cacheDir) env.cacheDir = cacheDir;
    env.allowRemoteModels = !offline;
    const sessionOptions = resolveSessionOptions(model);
    const pipeOpts: any = {
      revision,
      dtype: model.dtype || 'q8',
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    };
    const ext = await pipeline('feature-extraction', source, pipeOpts);
    _extractors.set(key, ext);
    return ext;
  };

  if (offline) {
    return await loadPipeline();
  }

  return await retryWithBackoff(loadPipeline, retryOpts);
}

export function prepareEmbeddingRequest(
  model: ModelDescriptor,
  texts: string[],
  kind: 'query' | 'passage'
): { input: string[]; options: { pooling: Pooling; normalize: boolean } } {
  if (model.unknownAdapter === true) {
    throw new Error(
      `model "${model.id}" is not a registered adapter and has no explicit ` +
        'configuration, so it cannot embed safely (issue #60) — supply an ' +
        'explicit adapter descriptor, see README "How to add a model".'
    );
  }
  const prefix = kind === 'query' ? model.queryPrefix : model.passagePrefix;
  const input = prefix ? texts.map((text) => prefix + text) : texts;
  return {
    input,
    options: { pooling: model.pooling ?? 'mean', normalize: model.normalize !== false },
  };
}

export async function embed(
  texts: string[],
  kind: 'query' | 'passage',
  model: ModelDescriptor,
  cacheDir: string,
  offline: boolean = false,
  retryOpts: { maxRetries?: number; delays?: number[]; log?: (msg: string) => void } = {}
): Promise<number[][]> {
  const ext = await getExtractor(model, cacheDir, offline, retryOpts);
  const { input, options } = prepareEmbeddingRequest(model, texts, kind);
  const out = await ext(input, options);
  return out.tolist();
}

export function cosine(
  a: Float32Array | number[],
  b: Float32Array | Int8Array | number[],
  bOffset: number = 0
): number {
  if (b instanceof Int8Array) {
    const qF32 = a instanceof Float32Array ? a : Float32Array.from(a);
    const chunkInt8 = bOffset === 0 && b.length === qF32.length ? b : b.subarray(bOffset, bOffset + qF32.length);
    return asymmetricCosineInt8(qF32, chunkInt8);
  }

  const len = a.length;
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0;
  let s4 = 0,
    s5 = 0,
    s6 = 0,
    s7 = 0;
  let i = 0;
  const limit = len - 7;
  while (i < limit) {
    s0 += a[i] * (b as ArrayLike<number>)[bOffset + i];
    s1 += a[i + 1] * (b as ArrayLike<number>)[bOffset + i + 1];
    s2 += a[i + 2] * (b as ArrayLike<number>)[bOffset + i + 2];
    s3 += a[i + 3] * (b as ArrayLike<number>)[bOffset + i + 3];
    s4 += a[i + 4] * (b as ArrayLike<number>)[bOffset + i + 4];
    s5 += a[i + 5] * (b as ArrayLike<number>)[bOffset + i + 5];
    s6 += a[i + 6] * (b as ArrayLike<number>)[bOffset + i + 6];
    s7 += a[i + 7] * (b as ArrayLike<number>)[bOffset + i + 7];
    i += 8;
  }
  let s = s0 + s1 + (s2 + s3) + (s4 + s5) + (s6 + s7);
  while (i < len) {
    s += a[i] * (b as ArrayLike<number>)[bOffset + i];
    i++;
  }
  return s;
}

export function encodeVec(vec: number[] | Float32Array): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

export function decodeVec(s: string, dim?: number): Float32Array {
  if (s.length === 0) {
    throw new Error('corrupt base64 vector: empty value — run `mdss index` to rebuild');
  }
  if (s.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new Error('corrupt base64 vector: encoding is not canonical — run `mdss index` to rebuild');
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) {
    throw new Error('corrupt base64 vector: encoding is not canonical — run `mdss index` to rebuild');
  }
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `corrupt base64 vector: ${buf.byteLength} bytes is not a multiple of 4 (a float32 is 4 bytes) — run \`mdss index\` to rebuild`
    );
  }
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (dim !== undefined && vec.length !== dim) {
    throw new Error(`corrupt vector: ${vec.length} dims, expected ${dim} — run \`mdss index\` to rebuild`);
  }
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) {
      throw new Error(`corrupt vector: non-finite value at index ${i} (NaN/Infinity) — run \`mdss index\` to rebuild`);
    }
  }
  return vec;
}

export function isBinaryIndex(index: { format?: string }): boolean {
  return index.format === 'binary-v1';
}

export function parseSchemaVersion(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('schemaVersion must be a non-negative safe integer — run `mdss index` to rebuild');
  }
  return value;
}

export function resolveIndexDimension(stored: unknown, known: number): number | undefined {
  if (stored !== undefined) {
    if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored <= 0) {
      throw new Error('index.dim must be a positive safe integer — run `mdss index` to rebuild');
    }
    if (known > 0 && stored !== known) {
      throw new Error(
        `index.dim ${stored} does not match known model dimension ${known} — run \`mdss index\` to rebuild`
      );
    }
    return stored;
  }
  return known > 0 ? known : undefined;
}

export const SCHEMA_VERSION = 3;

export function migrateToSchemaV2(index: { schemaVersion?: number }): void {
  index.schemaVersion = 2;
}

export function migrateToSchemaV3(): void {}

export const SCHEMA_MIGRATIONS: Record<number, (index: any) => void> = {
  1: () => {},
  2: migrateToSchemaV2,
  3: migrateToSchemaV3,
};

export function walkMarkdown(dir: string, ignore: string[] = []): string[] {
  const out: string[] = [];
  const ignoreRe = ignore.map(globToRegExp);
  const walk = (cur: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.name.startsWith('.')) continue;
      if (ignoreRe.some((re) => re.test(rel) || re.test(e.name))) continue;
      if (e.isDirectory()) walk(full);
      else if (/\.(md|markdown)$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function assertSafePath(targetPath: string, allowedRoots?: string[]): string {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('path must be a non-empty string');
  }
  if (targetPath.includes('\0')) {
    throw new Error('Forbidden path: null byte detected in path');
  }
  if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
    throw new Error('Forbidden path: UNC network paths not allowed');
  }
  if (/^[a-zA-Z]:[\\/]/.test(targetPath) && process.platform !== 'win32') {
    throw new Error('Forbidden path: Windows drive paths not allowed on non-Windows systems');
  }
  const resolved = path.resolve(targetPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    /* non-existent path */
  }

  let roots = allowedRoots;
  if (!roots || roots.length === 0) {
    if (process.env.MDSS_ROOT_GUARD) {
      roots = process.env.MDSS_ROOT_GUARD.split(path.delimiter).map((p) => path.resolve(p.trim())).filter(Boolean);
    }
  }

  if (roots && roots.length > 0) {
    const isAllowed = roots.some((root) => {
      let canonicalRoot = root;
      try {
        canonicalRoot = fs.realpathSync(root);
      } catch {}
      const rel = path.relative(canonicalRoot, canonical);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });

    if (!isAllowed) {
      throw new Error(
        `path traversal guard: "${targetPath}" (resolving to "${canonical}") is outside allowed directory roots`
      );
    }
  }

  return canonical;
}

export function validateGlob(glob: string): string {
  if (typeof glob !== 'string') throw new Error('glob must be a string');
  if (/[|()$`{}]/.test(glob)) {
    const match = glob.match(/[|()$`{}]/);
    throw new Error(`invalid glob pattern "${glob}": forbidden character "${match ? match[0] : ''}"`);
  }
  return glob;
}

export function globToRegExp(glob: string): RegExp {
  validateGlob(glob);
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
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

export function extractTitle(frontmatter: string, body: string, relPath: string): string {
  const fmTitle = frontmatter.match(/^title:\s*(.+)$/m);
  if (fmTitle) return fmTitle[1].trim().replace(/^["']|["']$/g, '');
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(relPath).replace(/\.(md|markdown)$/i, '');
}

const DEFAULT_MAX_CHUNK = 1400;

export function chunkMarkdown(body: string, maxChunk: number = DEFAULT_MAX_CHUNK): StructuralChunk[] {
  return chunkMarkdownStructural(body, maxChunk);
}

export interface ParsedChunkFile {
  file: string;
  title: string;
  heading: string;
  headingPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  meta: DocumentMetadata;
}

export function parseFile(absPath: string, dbDir: string, maxChunk?: number, raw?: string): ParsedChunkFile[] {
  const content = raw ?? fs.readFileSync(absPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);
  const rel = path.relative(dbDir, absPath).split(path.sep).join('/');
  const title = meta.title || extractTitle(frontmatter, body, rel);
  const frontmatterLineCount = frontmatter ? frontmatter.split('\n').length + 2 : 0;
  return chunkMarkdown(body, maxChunk).map((c) => {
    const heading = c.heading || title;
    return {
      file: rel,
      title,
      heading,
      headingPath: c.headingPath.length > 0 ? c.headingPath : [heading],
      text: c.text,
      startLine: (c.startLine || 1) + frontmatterLineCount,
      endLine: (c.endLine || 1) + frontmatterLineCount,
      meta,
    };
  });
}

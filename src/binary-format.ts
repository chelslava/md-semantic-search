/**
 * Zero-Copy Binary Index Storage (vectors.bin) format (issue #95).
 *
 * Binary Layout:
 * ┌────────────────────────────────────────────────────────┐
 * │ Header (64 bytes):                                     │
 * │  0..7:   Magic 'MDSSBIN1'                              │
 * │  8..11:  Version (uint32 = 1)                          │
 * │  12..15: Flags (uint32: 0=FP32, 1=INT8)               │
 * │  16..19: Dim (uint32)                                  │
 * │  20..23: ChunkCount (uint32)                           │
 * │  24..31: VectorsOffset (uint64)                        │
 * │  32..39: VectorsBytes (uint64)                         │
 * │  40..47: MetadataOffset (uint64)                       │
 * │  48..55: MetadataBytes (uint64)                        │
 * │  56..63: Reserved (8 bytes zeros)                      │
 * ├────────────────────────────────────────────────────────┤
 * │ Vectors Section:                                       │
 * │  Contiguous float32 array: [chunkCount * dim * 4 bytes]│
 * ├────────────────────────────────────────────────────────┤
 * │ Metadata Section:                                      │
 * │  UTF-8 JSON string (chunks metadata + lexical state)   │
 * └────────────────────────────────────────────────────────┘
 */
import { decodeVec } from './core.js';
import { PersistedIndex, IndexChunk } from './indexer.js';
import { quantizeToInt8 } from './quantization.js';

export const BINARY_MAGIC = 'MDSSBIN1';
export const BINARY_HEADER_SIZE = 64;
export const BINARY_VERSION = 1;

export const BINARY_FLAG_FP32 = 0;
export const BINARY_FLAG_INT8 = 1;

export interface BinaryIndexHeader {
  version: number;
  flags: number;
  dim: number;
  chunkCount: number;
  vectorsOffset: number;
  vectorsBytes: number;
  metadataOffset: number;
  metadataBytes: number;
}

export interface SerializeBinaryOptions {
  quantize?: 'fp32' | 'int8';
}

export interface BinaryStreamOptions extends SerializeBinaryOptions {
  /**
   * issue #265 step 2: drop each chunk's in-memory vector as soon as its row
   * is written. The final build pass uses this to release the fp32 corpus
   * progressively instead of holding it until the process exits; callers that
   * reuse the chunks afterwards must leave it unset.
   */
  releaseVectors?: boolean;
}

/**
 * issue #265 step 2: the byte-exact pieces of a vectors.bin file, yielded
 * sequentially (64-byte header, then one zero-padded vector row per chunk,
 * then the metadata JSON). Concatenating the parts is identical to what the
 * old materializing serializer produced (frozen in
 * `test/fixtures/persistence-golden.json`), but only ONE vector row is ever
 * alive at a time — the count×dim monolith and its full-file copy are gone.
 */
export function* binaryFileParts(
  index: PersistedIndex,
  chunks: ReadonlyArray<IndexChunk>,
  dim: number,
  options: BinaryStreamOptions = {}
): Generator<string | Buffer> {
  const isInt8 = options.quantize === 'int8';
  const bytesPerElement = isInt8 ? 1 : 4;
  const count = chunks.length;
  const vectorsBytes = count * dim * bytesPerElement;
  const vectorsOffset = BINARY_HEADER_SIZE;
  const flags = isInt8 ? BINARY_FLAG_INT8 : BINARY_FLAG_FP32;

  // Build metadata JSON omitting per-chunk vec strings to save space — as one
  // string, because the 64-byte header (yielded first) needs its exact length.
  const metadataChunks: Array<Omit<IndexChunk, 'vec'>> = chunks.map((c) => ({
    file: c.file,
    title: c.title,
    heading: c.heading,
    headingPath: c.headingPath,
    text: c.text,
    chunkHash: c.chunkHash,
    startLine: c.startLine,
    endLine: c.endLine,
    meta: c.meta,
  }));

  const metadataObj = {
    schemaVersion: index.schemaVersion,
    format: 'binary-v1',
    model: index.model,
    modelAlias: index.modelAlias,
    adapterFingerprint: index.adapterFingerprint,
    dim,
    db: index.db,
    built: index.built,
    complete: index.complete,
    chunkCount: count,
    quantized: isInt8 ? 'int8' : 'fp32',
    lexical: index.lexical,
    lexicalFormat: index.lexicalFormat,
    chunks: metadataChunks,
  };

  const metadataBuffer = Buffer.from(JSON.stringify(metadataObj), 'utf8');
  const metadataOffset = vectorsOffset + vectorsBytes;
  const metadataBytes = metadataBuffer.length;

  // Write 64-byte header
  const header = Buffer.alloc(BINARY_HEADER_SIZE);
  header.write(BINARY_MAGIC, 0, 8, 'ascii');
  header.writeUInt32LE(BINARY_VERSION, 8);
  header.writeUInt32LE(flags, 12);
  header.writeUInt32LE(dim, 16);
  header.writeUInt32LE(count, 20);
  header.writeBigUInt64LE(BigInt(vectorsOffset), 24);
  header.writeBigUInt64LE(BigInt(vectorsBytes), 32);
  header.writeBigUInt64LE(BigInt(metadataOffset), 40);
  header.writeBigUInt64LE(BigInt(metadataBytes), 48);
  yield header;

  for (let i = 0; i < count; i++) {
    const chunk = chunks[i];
    let v: ArrayLike<number>;
    if (typeof chunk.vec === 'string') {
      v = decodeVec(chunk.vec, dim);
    } else if (chunk.vec instanceof Float32Array || chunk.vec instanceof Int8Array || Array.isArray(chunk.vec)) {
      v = chunk.vec;
    } else {
      throw new Error(`chunk ${i} is missing vector for binary serialization`);
    }

    // One zero-padded row at a time — same bytes the contiguous rawArray held.
    if (isInt8) {
      const row = new Int8Array(dim);
      row.set(v instanceof Int8Array ? v : quantizeToInt8(v));
      yield Buffer.from(row.buffer, row.byteOffset, row.byteLength);
    } else {
      const row = new Float32Array(dim);
      row.set(v);
      yield Buffer.from(row.buffer, row.byteOffset, row.byteLength);
    }
    if (options.releaseVectors) chunk.vec = undefined;
  }

  yield metadataBuffer;
}

export function serializeBinaryIndex(
  index: PersistedIndex,
  dim: number,
  options: SerializeBinaryOptions = {}
): Buffer {
  // issue #265 step 2: thin wrapper over the streaming generator — the
  // materializing implementation is gone; byte-identity with it is pinned by
  // the golden fixture test.
  const parts = Array.from(binaryFileParts(index, index.chunks, dim, options));
  return Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : part)));
}

export function readBinaryHeader(buffer: Buffer): BinaryIndexHeader {
  if (buffer.length < BINARY_HEADER_SIZE) {
    throw new Error(`Invalid binary index: file too small (${buffer.length} bytes, expected at least ${BINARY_HEADER_SIZE})`);
  }
  const magic = buffer.toString('ascii', 0, 8);
  if (magic !== BINARY_MAGIC) {
    throw new Error(`Invalid binary index magic: expected "${BINARY_MAGIC}", got "${magic}"`);
  }
  const version = buffer.readUInt32LE(8);
  // issue #189: version was parsed but never checked — a future-format file
  // would silently decode as garbage vectors
  if (version !== BINARY_VERSION) {
    throw new Error(
      `Invalid binary index: unsupported version ${version} (expected ${BINARY_VERSION}) — run \`mdss index\` to rebuild`,
    );
  }
  const flags = buffer.readUInt32LE(12);
  // issue #189: unknown flag bits silently decoded as fp32 garbage
  if (flags !== BINARY_FLAG_FP32 && flags !== BINARY_FLAG_INT8) {
    throw new Error(
      `Invalid binary index: unknown flags 0x${flags.toString(16)} (expected 0 or 1) — run \`mdss index\` to rebuild`,
    );
  }
  const dim = buffer.readUInt32LE(16);
  const chunkCount = buffer.readUInt32LE(20);
  const vectorsOffset = Number(buffer.readBigUInt64LE(24));
  const vectorsBytes = Number(buffer.readBigUInt64LE(32));
  const metadataOffset = Number(buffer.readBigUInt64LE(40));
  const metadataBytes = Number(buffer.readBigUInt64LE(48));

  return {
    version,
    flags,
    dim,
    chunkCount,
    vectorsOffset,
    vectorsBytes,
    metadataOffset,
    metadataBytes,
  };
}

export function deserializeBinaryIndex(
  buffer: Buffer
): PersistedIndex & { rawVectorsBuffer: Float32Array | Int8Array; quantized?: 'fp32' | 'int8' } {
  const header = readBinaryHeader(buffer);
  const { flags, dim, chunkCount, vectorsOffset, vectorsBytes, metadataOffset, metadataBytes } = header;
  const isInt8 = (flags & BINARY_FLAG_INT8) !== 0;
  const expectedVectorsBytes = chunkCount * dim * (isInt8 ? 1 : 4);
  if (buffer.length < vectorsOffset + expectedVectorsBytes || buffer.length < metadataOffset + metadataBytes) {
    throw new Error('Corrupt binary index: unexpected truncated file');
  }
  const byteOffset = buffer.byteOffset + vectorsOffset;
  let rawVectorsBuffer: Float32Array | Int8Array;

  if (isInt8) {
    rawVectorsBuffer = new Int8Array(buffer.buffer, byteOffset, chunkCount * dim);
  } else {
    // Aligned 4-byte Float32Array view
    if (byteOffset % 4 === 0) {
      rawVectorsBuffer = new Float32Array(buffer.buffer, byteOffset, chunkCount * dim);
    } else {
      const aligned = Buffer.alloc(vectorsBytes);
      buffer.copy(aligned, 0, vectorsOffset, vectorsOffset + vectorsBytes);
      rawVectorsBuffer = new Float32Array(aligned.buffer, aligned.byteOffset, chunkCount * dim);
    }
  }

  // Deserialize metadata JSON
  const metaJson = buffer.toString('utf8', metadataOffset, metadataOffset + metadataBytes);
  const parsed = JSON.parse(metaJson);

  // Re-attach subarray views to chunks
  const chunks: IndexChunk[] = parsed.chunks.map((c: any, i: number) => {
    const vecSlice = rawVectorsBuffer.subarray(i * dim, (i + 1) * dim);
    return {
      ...c,
      vec: vecSlice,
    };
  });

  return {
    ...parsed,
    chunks,
    rawVectorsBuffer,
    quantized: isInt8 ? 'int8' : 'fp32',
  };
}

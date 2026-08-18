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

export function serializeBinaryIndex(
  index: PersistedIndex,
  dim: number,
  options: SerializeBinaryOptions = {}
): Buffer {
  const isInt8 = options.quantize === 'int8';
  const bytesPerElement = isInt8 ? 1 : 4;
  const count = index.chunks.length;
  const vectorsBytes = count * dim * bytesPerElement;
  const vectorsOffset = BINARY_HEADER_SIZE;
  const flags = isInt8 ? BINARY_FLAG_INT8 : BINARY_FLAG_FP32;

  // Build contiguous typed array
  const rawArray = isInt8 ? new Int8Array(count * dim) : new Float32Array(count * dim);

  for (let i = 0; i < count; i++) {
    const chunk = index.chunks[i];
    let v: ArrayLike<number>;
    if (typeof chunk.vec === 'string') {
      v = decodeVec(chunk.vec, dim);
    } else if (chunk.vec instanceof Float32Array || chunk.vec instanceof Int8Array || Array.isArray(chunk.vec)) {
      v = chunk.vec;
    } else {
      throw new Error(`chunk ${i} is missing vector for binary serialization`);
    }

    if (isInt8) {
      const q = v instanceof Int8Array ? v : quantizeToInt8(v);
      (rawArray as Int8Array).set(q, i * dim);
    } else {
      (rawArray as Float32Array).set(v, i * dim);
    }
  }

  // Build metadata JSON omitting per-chunk vec strings to save space
  const metadataChunks: Array<Omit<IndexChunk, 'vec'>> = index.chunks.map((c) => ({
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

  const totalSize = metadataOffset + metadataBytes;
  const out = Buffer.alloc(totalSize);

  // Write 64-byte header
  out.write(BINARY_MAGIC, 0, 8, 'ascii');
  out.writeUInt32LE(BINARY_VERSION, 8);
  out.writeUInt32LE(flags, 12);
  out.writeUInt32LE(dim, 16);
  out.writeUInt32LE(count, 20);
  out.writeBigUInt64LE(BigInt(vectorsOffset), 24);
  out.writeBigUInt64LE(BigInt(vectorsBytes), 32);
  out.writeBigUInt64LE(BigInt(metadataOffset), 40);
  out.writeBigUInt64LE(BigInt(metadataBytes), 48);

  // Copy vectors
  Buffer.from(rawArray.buffer, rawArray.byteOffset, rawArray.byteLength).copy(out, vectorsOffset);

  // Copy metadata
  metadataBuffer.copy(out, metadataOffset);

  return out;
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
  const flags = buffer.readUInt32LE(12);
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

  if (buffer.length < metadataOffset + metadataBytes) {
    throw new Error('Corrupt binary index: unexpected truncated file');
  }

  const isInt8 = (flags & BINARY_FLAG_INT8) !== 0;
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

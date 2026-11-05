/**
 * WASM SIMD128 dot-product engine for the HNSW graph build (issue #228).
 *
 * The build's cost profile is ~85% distance computation (measured: 16.5k
 * distance calls per node at n=5000, dim=256; RESEARCH.md §17), and those
 * calls sit on a sequential dependency chain — worker_threads parallelism is
 * structurally blocked (per-insert graph state + the byte-identical-sidecar
 * determinism contract). The achievable lever is making each dot faster:
 * this module batches f32 dot products into ONE WebAssembly call
 * (`dot_batch`: N row indices → N dot products against a shared query row)
 * with a SIMD128 mul/add inner loop — measured ~6× over the unrolled JS dot
 * at dim=256 on a 32-dot batch.
 *
 * Zero native dependencies: the module is 363 bytes of hand-written WAT
 * compiled once via wabt and embedded below (source of record:
 * bench/ann-recall.mjs history + RESEARCH.md §17). Compile failure (no SIMD
 * in the runtime) degrades to `null` and the caller keeps the JS closure path.
 *
 * Determinism: all arithmetic is IEEE f32 with a fixed lane order — repeated
 * builds on the same corpus produce a byte-identical sidecar per engine. The
 * SIMD accumulation order differs from the JS closure path in the last ulp,
 * so the two engines are each self-consistent but not cross-identical; the
 * sidecar records which engine built it (same engine → same bytes).
 */

/** The compiled `dot_batch` module (see module docstring for provenance). */
const KERNEL_B64 =
  'AGFzbQEAAAABCQFgBX9/f39/AAMCAQAFAwEAAQcTAgNtZW0CAAlkb3RfYmF0Y2gAAAq3AgG0AgQCfwF9An8EeyADQQRsIQlBACEF' +
  'AkADQCAFIAJODQEgASAFQQRsaigCACAJbCEG/QwAAAAAAAAAAAAAAAAAAAAAIQr9DAAAAAAAAAAAAAAAAAAAAAAhC/0MAAAAAAAAA' +
  'AAAAAAAAAAAACEM/QwAAAAAAAAAAAAAAAAAAAAAIQ1DAAAAACEHQQAhCAJAA0AgCEEQaiAJSg0BIAogACAIav0AAgAgBiAIav0A' +
  'AgD95gH95AEhCiAIQRBqIQgMAAsLAkADQCAIIAlODQEgByAAIAhqKgIAIAYgCGoqAgCUkiEHIAhBBGohCAwACwsgBCAFQQRsaiAK' +
  '/R8AIAr9HwGSIAr9HwIgCv0fA5KSIAcgC/0fACAL/R8BkiAL/R8CIAv9HwOSkpKSOAIAIAVBAWohBQwACwsL';

export interface WasmDotEngine {
  /** dot(vectors[a], vectors[b]) — one-row batch, same arithmetic as batch(). */
  point(aIdx: number, bIdx: number): number;
  /** result[j] = dot(vectors[aIdx], vectors[nodes[j]]) — a view into wasm memory, valid until the next call. */
  batch(aIdx: number, nodes: number[]): Float32Array;
  readonly dim: number;
}

/** Max nodes per batch call — HNSW neighbor lists cap at M0 = 2*M ≤ 64. */
const MAX_BATCH = 64;

/**
 * Build the engine over a uniform Float32Array matrix. Returns null when the
 * runtime cannot compile the SIMD module (then callers keep the JS path).
 */
export function createWasmDotEngine(vectors: Array<Float32Array>): WasmDotEngine | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  if (dim === 0) return null;
  for (const v of vectors) {
    if (!(v instanceof Float32Array) || v.length !== dim) return null;
  }

  let kernelBuffer: ArrayBuffer;
  try {
    const bin = Buffer.from(KERNEL_B64, 'base64');
    kernelBuffer = new ArrayBuffer(bin.byteLength);
    new Uint8Array(kernelBuffer).set(bin);
    if (bin.byteLength === 0) return null;
  } catch {
    return null;
  }
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(kernelBuffer), {});
  } catch {
    return null; // no SIMD support — caller falls back to the JS closure path
  }
  const exp = instance.exports as unknown as {
    mem: WebAssembly.Memory;
    dot_batch: (q: number, idx: number, n: number, dim: number, out: number) => void;
  };
  const mem = exp.mem;

  // Linear memory layout: [vectors row-major][idx scratch u32 × MAX_BATCH][out f32 × MAX_BATCH]
  const vecBytes = vectors.length * dim * 4;
  const idxByte = vecBytes;
  const outByte = idxByte + MAX_BATCH * 4;
  const needBytes = outByte + MAX_BATCH * 4 + 4096;
  const pages = Math.ceil(needBytes / 65536);
  try {
    if (mem.buffer.byteLength < needBytes) mem.grow(pages);
  } catch {
    return null;
  }
  // Views are created AFTER the final grow — growing detaches old buffers.
  const f32 = new Float32Array(mem.buffer);
  const u32 = new Uint32Array(mem.buffer);
  for (let i = 0; i < vectors.length; i++) f32.set(vectors[i], i * dim);

  const qByteOf = (aIdx: number) => {
    if (!Number.isSafeInteger(aIdx) || aIdx < 0 || aIdx >= vectors.length) {
      throw new Error(`wasm-dot: row index out of range: ${aIdx}`);
    }
    return aIdx * dim * 4;
  };

  return {
    dim,
    point(aIdx: number, bIdx: number): number {
      u32[idxByte >> 2] = bIdx;
      exp.dot_batch(qByteOf(aIdx), idxByte, 1, dim, outByte);
      return f32[outByte >> 2];
    },
    batch(aIdx: number, nodes: number[]): Float32Array {
      const n = Math.min(nodes.length, MAX_BATCH);
      for (let j = 0; j < n; j++) u32[(idxByte >> 2) + j] = nodes[j];
      exp.dot_batch(qByteOf(aIdx), idxByte, n, dim, outByte);
      return f32.subarray(outByte >> 2, (outByte >> 2) + n);
    },
  };
}

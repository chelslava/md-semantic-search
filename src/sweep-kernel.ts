/**
 * RESEARCH §13 pointwise sweep-kernel (issue #259) — the DEFAULT dense-sweep
 * engine since the measured land: the #254 profiling gate breached the
 * pre-registered >40% JS float-math trigger at 100k chunks, and this kernel
 * measured a −23.5% (50k) / −15.2% (100k) warm-hybrid p50 win with an exact
 * golden-gate match (nDCG@10 0.8653 → 0.8653, Recall@10 1.0). Unlike the #228
 * build-side kernel (`src/wasm-dot.ts`, batch of ≤64 dots per call), the
 * query-side sweep is a single shared query vector scored against candidate
 * rows, so this kernel pushes the whole candidate list through ONE boundary
 * crossing per sweep:
 *
 *   - 'wasm' (default) — SIMD128 kernel: f32 dot (f32x4 mul/add) for fp32
 *     corpora, and int8→f32 widening (extmul-with-1 +
 *     `f32x4.convert_i32x4_s`, exact for every int8 lane) for int8 corpora
 *     with the JS-cached chunk norms. The accumulation order differs from JS
 *     in the last ulp (same arithmetic class — IEEE f32 mul/add), mirroring
 *     the #228 sidecar engine contract: each engine is self-consistent,
 *     engines are not cross-identical.
 *   - 'js-flat' — unrolled scalar sweep over FLAT buffers, measured as a
 *     candidate and NOT landed: no win over the per-chunk path (V8's own
 *     codegen is already optimal) — kept behind the flag as the reference
 *     measurement only.
 *
 * The corpus + norms are copied into WASM linear memory once per index
 * generation (lazily, on the first kernel query — the same cold-build
 * pattern as the runtime IVF/HNSW caches). Zero native dependencies; compile
 * failure (no SIMD in the runtime) degrades to `null` and the caller keeps
 * the per-chunk JS path. Unsupported shapes (MRL-truncated queries, ragged
 * corpora, int8 without cached norms) fall back to JS the same way.
 *
 * Determinism: repeated sweeps of the same corpus/query produce identical
 * scores per engine, so search results stay deterministic per engine.
 *
 * The embedded module (994 bytes) is compiled from the WAT below (compiled
 * once via wabt; `wat2wasm sweep.wat`) — the WAT text is the source of record.
 *
 * (module
 *   (memory (export "mem") 1)
 *   (func $sweep_f32 (export "sweep_f32")
 *     (param $q i32) (param $corpus i32) (param $idx i32)
 *     (param $n i32) (param $dimByte i32) (param $out i32)
 *     ;; per row: 4× f32x4 mul/add accumulators over 64-byte blocks,
 *     ;; scalar tail loop, then a 2+2 horizontal add; out[i] = dot
 *   )
 *   (func $sweep_i8 (export "sweep_i8")
 *     (param $q i32) (param $corpus i32) (param $idx i32)
 *     (param $n i32) (param $dim i32) (param $norms i32) (param $out i32)
 *     ;; per row: load i8x16 → widen via extmul-with-1 → f32x4 lanes
 *     ;; (convert_i32x4_s) → mul by q f32x4 → accumulate; scalar tail with
 *     ;; i32.load8_s + f32.convert_i32_s; out[i] = norm > 0 ? dot/norm : 0
 *   )
 * )
 */

export type SweepKernelMode = 'js' | 'js-flat' | 'wasm';

const SWEEP_KERNEL_MODES: readonly SweepKernelMode[] = ['js', 'js-flat', 'wasm'];

/**
 * Resolve a raw flag value (`SearchOptions.sweepKernel` or the
 * `MDSS_SWEEP_KERNEL` env override) to a mode. Throws on an unknown value so
 * direct programmatic misuse is loud; env callers may catch and fall back.
 */
export function resolveSweepKernel(raw: unknown): SweepKernelMode {
  if (raw === undefined || raw === null || raw === '') return 'js';
  if (typeof raw === 'string' && (SWEEP_KERNEL_MODES as readonly string[]).includes(raw)) {
    return raw as SweepKernelMode;
  }
  throw new Error(`invalid sweep kernel mode: ${String(raw)} (expected one of ${SWEEP_KERNEL_MODES.join(', ')})`);
}

/** The compiled `sweep_f32`/`sweep_i8` module (see module docstring for provenance). */
const KERNEL_B64 =
  'AGFzbQEAAAABFAJgBn9/f39/fwBgB39/f39/f38AAwMCAAEFAwEAAQceAwNtZW0CAAlzd2VlcF9mMzIAAAhzd2VlcF9pOAABCpcHAvQCAwR/BXsCfUEAIQYCQANAIAYgA08NASABIAIgBkEEbGooAgAgBGxqIQdDAAAAAP0TIQpDAAAAAP0TIQtDAAAAAP0TIQxDAAAAAP0TIQ1BACEIIAQgBEHAAHBrIQkCQANAIAggCU8NASAKIAcgCGr9AAQAIAAgCGr9AAQA/eYB/eQBIQogCyAHIAhqQRBq/QAEACAAIAhqQRBq/QAEAP3mAf3kASELIAwgByAIakEgav0ABAAgACAIakEgav0ABAD95gH95AEhDCANIAcgCGpBMGr9AAQAIAAgCGpBMGr9AAQA/eYB/eQBIQ0gCEHAAGohCAwACwtDAAAAACEPAkADQCAIIARPDQEgDyAHIAhqKgIAIAAgCGoqAgCUkiEPIAhBBGohCAwACwsgCiAL/eQBIAwgDf3kAf3kASEOIA79HwAgDv0fAZIgDv0fAiAO/R8DkpIhECAQIA+SIRAgBSAGQQRsaiAQOAIAIAZBAWohBgwACwsLngQDBX8IewN9QQAhBwJAA0AgByADTw0BIAIgB0EEbGooAgAhCyABIAsgBGxqIQhDAAAAAP0TIQxDAAAAAP0TIQ1DAAAAAP0TIQ5DAAAAAP0TIQ9BACEJIAQgBEEQcGshCgJAA0AgCSAKTw0BIAggCWr9AAQAIRAgEP0MAQEBAQEBAQEBAQEBAQEBAf2cASERIBD9DAEBAQEBAQEBAQEBAQEBAQH9nQEhEiAMIAAgCUEEbGr9AAQAIBH9DAEAAQABAAEAAQABAAEAAQD9vAH9+gH95gH95AEhDCANIAAgCUEEbGpBEGr9AAQAIBH9DAEAAQABAAEAAQABAAEAAQD9vQH9+gH95gH95AEhDSAOIAAgCUEEbGpBIGr9AAQAIBL9DAEAAQABAAEAAQABAAEAAQD9vAH9+gH95gH95AEhDiAPIAAgCUEEbGpBMGr9AAQAIBL9DAEAAQABAAEAAQABAAEAAQD9vQH9+gH95gH95AEhDyAJQRBqIQkMAAsLQwAAAAAhFAJAA0AgCSAETw0BIBQgACAJQQRsaioCACAIIAlqLAAAspSSIRQgCUEBaiEJDAALCyAMIA395AEgDiAP/eQB/eQBIRMgE/0fACAT/R8BkiAT/R8CIBP9HwOSkiEWIBYgFJIhFiAFIAtBBGxqKgIAIRUgBiAHQQRsaiAWIBWVQwAAAAAgFUMAAAAAXBwBfTgCACAHQQFqIQcMAAsLCw==';

interface SweepExports {
  mem: WebAssembly.Memory;
  sweep_f32: (q: number, corpus: number, idx: number, n: number, dimByte: number, out: number) => void;
  sweep_i8: (q: number, corpus: number, idx: number, n: number, dim: number, norms: number, out: number) => void;
}

/** The compiled module is process-wide shared — engines only differ in memory contents. */
let compiledModule: WebAssembly.Module | null = null;
function compileKernel(): WebAssembly.Module | null {
  if (compiledModule) return compiledModule;
  try {
    const bin = Buffer.from(KERNEL_B64, 'base64');
    if (bin.byteLength === 0) return null;
    compiledModule = new WebAssembly.Module(new Uint8Array(bin));
    return compiledModule;
  } catch {
    return null; // no SIMD support — caller falls back to the JS path
  }
}

export interface WasmSweepEngine {
  /**
   * out[j] = score for row indices[j] against qVec — one WASM call per sweep.
   * fp32 rows: dot(q, row). int8 rows: dot(q, dequant(row)) / norms[row] with
   * 0 for zero-norm rows (mirrors asymmetricCosineInt8CachedNorm).
   */
  sweep(qVec: Float32Array, indices: ArrayLike<number>, out: Float32Array): void;
  readonly format: 'fp32' | 'int8';
  readonly dim: number;
  readonly count: number;
}

/**
 * Build the engine over a flat row-major corpus. `corpus` is either an Int8Array
 * (count*dim bytes, `norms` REQUIRED — the JS-cached int8 norms) or a Float32Array
 * (count*dim floats). Returns null when the runtime cannot compile the SIMD module
 * or the arguments do not fit (then callers keep the JS path).
 */
export function createWasmSweepEngine(
  corpus: Int8Array | Float32Array,
  norms: Float32Array | null,
  dim: number,
  count: number,
): WasmSweepEngine | null {
  if (!(dim > 0) || !(count > 0) || corpus.length < count * dim) return null;
  const isInt8 = corpus instanceof Int8Array;
  if (isInt8 && !(norms instanceof Float32Array && norms.length >= count)) return null;

  const module = compileKernel();
  if (!module) return null;
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, {});
  } catch {
    return null;
  }
  const exp = instance.exports as unknown as SweepExports;
  const mem = exp.mem;

  // Linear memory layout: [q f32 × dim][corpus rows][int8: norms f32 × count][idx u32 × count][out f32 × count]
  const qByte = 0;
  const corpusByte = qByte + dim * 4;
  const normsByte = corpusByte + (isInt8 ? count * dim : count * dim * 4);
  const idxByte = normsByte + (isInt8 ? count * 4 : 0);
  const outByte = idxByte + count * 4;
  const needBytes = outByte + count * 4;
  const pages = Math.ceil(needBytes / 65536);
  try {
    if (mem.buffer.byteLength < needBytes) mem.grow(pages);
  } catch {
    return null;
  }
  // Views are created AFTER the final grow — growing detaches old buffers.
  const f32 = new Float32Array(mem.buffer);
  const u32 = new Uint32Array(mem.buffer);
  const i8 = new Int8Array(mem.buffer);
  if (isInt8) i8.set(corpus as Int8Array, corpusByte);
  else f32.set(corpus as Float32Array, corpusByte >> 2);
  if (isInt8 && norms) f32.set(norms.subarray(0, count), normsByte >> 2);

  return {
    format: isInt8 ? 'int8' : 'fp32',
    dim,
    count,
    sweep(qVec: Float32Array, indices: ArrayLike<number>, out: Float32Array): void {
      const n = Math.min(indices.length, count, out.length);
      if (n <= 0 || qVec.length !== dim) return;
      f32.set(qVec, qByte >> 2);
      for (let j = 0; j < n; j++) {
        const row = indices[j];
        if (!Number.isSafeInteger(row) || row < 0 || row >= count) {
          throw new Error(`sweep-kernel: row index out of range: ${row}`);
        }
        u32[(idxByte >> 2) + j] = row;
      }
      if (isInt8) {
        exp.sweep_i8(qByte, corpusByte, idxByte, n, dim, normsByte, outByte);
      } else {
        exp.sweep_f32(qByte, corpusByte, idxByte, n, dim * 4, outByte);
      }
      out.set(f32.subarray(outByte >> 2, (outByte >> 2) + n), 0);
    },
  };
}

/**
 * Flat row-major copy of every chunk vector (zero-copy view when the runtime
 * chunks are contiguous subarray views over one buffer — the binary-format
 * load path; per-row copy otherwise, e.g. legacy vectors.json indexes).
 * Returns null when the corpus is empty or ragged (mixed dims/lengths).
 */
export function collectFlatCorpus(
  chunks: ArrayLike<{ vec: Float32Array | Int8Array }>,
): { i8: Int8Array | null; f32: Float32Array | null } | null {
  const count = chunks.length;
  if (count === 0) return null;
  const first = chunks[0].vec;
  const dim = first.length;
  if (!(dim > 0)) return null;
  const isInt8 = first instanceof Int8Array;

  if (isInt8) {
    const base = (first as Int8Array).byteOffset;
    const buf = (first as Int8Array).buffer;
    let contiguous = buf.byteLength - base >= count * dim;
    if (contiguous) {
      for (let i = 0; i < count; i++) {
        const v = chunks[i].vec;
        if (!(v instanceof Int8Array) || v.byteOffset !== base + i * dim || v.length !== dim) {
          contiguous = false;
          break;
        }
      }
    }
    if (contiguous) return { i8: new Int8Array(buf, base, count * dim), f32: null };
    const flat = new Int8Array(count * dim);
    for (let i = 0; i < count; i++) {
      const v = chunks[i].vec;
      if (!(v instanceof Int8Array) || v.length !== dim) return null;
      flat.set(v, i * dim);
    }
    return { i8: flat, f32: null };
  }

  const base = (first as Float32Array).byteOffset;
  const buf = (first as Float32Array).buffer;
  let contiguous = buf.byteLength - base >= count * dim * 4;
  if (contiguous) {
    for (let i = 0; i < count; i++) {
      const v = chunks[i].vec;
      if (!(v instanceof Float32Array) || v.byteOffset !== base + i * dim * 4 || v.length !== dim) {
        contiguous = false;
        break;
      }
    }
  }
  if (contiguous) return { i8: null, f32: new Float32Array(buf, base, count * dim) };
  const flat = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) {
    const v = chunks[i].vec;
    if (!(v instanceof Float32Array) || v.length !== dim) return null;
    flat.set(v, i * dim);
  }
  return { i8: null, f32: flat };
}

/**
 * 'js-flat' candidate: unrolled scalar sweep over the flat corpus — the same
 * accumulation order as `asymmetricCosineInt8CachedNorm(qVec, chunk,
 * norms[idx])` per row (norms REQUIRED; zero-norm rows score 0); equal to the
 * shipped path within the last f32 ulp (V8 FMA contraction may differ across
 * functions).
 */
export function sweepInt8Flat(
  qVec: Float32Array,
  corpus: Int8Array,
  indices: ArrayLike<number>,
  out: Float32Array,
  norms: Float32Array,
  dim: number,
): void {
  const n = Math.min(indices.length, out.length);
  const limit = dim - (dim % 8);
  for (let j = 0; j < n; j++) {
    const row = indices[j] * dim;
    const norm = norms[indices[j]];
    if (!(norm > 0)) {
      out[j] = 0;
      continue;
    }
    let dot = 0.0;
    let i = 0;
    for (; i < limit; i += 8) {
      dot +=
        qVec[i] * corpus[row + i] +
        qVec[i + 1] * corpus[row + i + 1] +
        qVec[i + 2] * corpus[row + i + 2] +
        qVec[i + 3] * corpus[row + i + 3] +
        qVec[i + 4] * corpus[row + i + 4] +
        qVec[i + 5] * corpus[row + i + 5] +
        qVec[i + 6] * corpus[row + i + 6] +
        qVec[i + 7] * corpus[row + i + 7];
    }
    for (; i < dim; i++) {
      dot += qVec[i] * corpus[row + i];
    }
    out[j] = dot / norm;
  }
}

/**
 * 'js-flat' candidate for fp32 corpora: unrolled 8-accumulator dot over the
 * flat corpus — the same accumulation order as `core.cosine(qVec, chunk)`
 * per row (vectors are unit-normalized, so cosine IS the dot in this
 * codebase); equal within the last f32 ulp (V8 FMA contraction).
 */
export function sweepFp32Flat(
  qVec: Float32Array,
  corpus: Float32Array,
  indices: ArrayLike<number>,
  out: Float32Array,
  dim: number,
): void {
  const n = Math.min(indices.length, out.length);
  for (let j = 0; j < n; j++) {
    const off = indices[j] * dim;
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0;
    let s4 = 0,
      s5 = 0,
      s6 = 0,
      s7 = 0;
    let i = 0;
    const limit = dim - 7;
    while (i < limit) {
      s0 += qVec[i] * corpus[off + i];
      s1 += qVec[i + 1] * corpus[off + i + 1];
      s2 += qVec[i + 2] * corpus[off + i + 2];
      s3 += qVec[i + 3] * corpus[off + i + 3];
      s4 += qVec[i + 4] * corpus[off + i + 4];
      s5 += qVec[i + 5] * corpus[off + i + 5];
      s6 += qVec[i + 6] * corpus[off + i + 6];
      s7 += qVec[i + 7] * corpus[off + i + 7];
      i += 8;
    }
    let s = s0 + s1 + (s2 + s3) + (s4 + s5) + (s6 + s7);
    while (i < dim) {
      s += qVec[i] * corpus[off + i];
      i++;
    }
    out[j] = s;
  }
}

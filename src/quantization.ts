/**
 * Int8 Scalar Quantization Tier (issue #96).
 *
 * Maps normalized Float32 unit vectors in [-1.0, 1.0] to signed 8-bit integers in [-128, 127],
 * providing 4x memory savings with <1% loss in ranking precision.
 */

export const INT8_SCALE = 127.0;
export const INT8_INV_SCALE = 1.0 / 127.0;

/**
 * Quantizes an L2-normalized float vector into a signed Int8Array.
 */
export function quantizeToInt8(vec: ArrayLike<number>): Int8Array {
  const len = vec.length;
  const out = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    const val = vec[i];
    // Clamp to [-1.0, 1.0] and scale to [-128, 127]
    const clamped = val < -1.0 ? -1.0 : val > 1.0 ? 1.0 : val;
    const scaled = Math.round(clamped * INT8_SCALE);
    out[i] = scaled < -128 ? -128 : scaled > 127 ? 127 : scaled;
  }
  return out;
}

/**
 * Dequantizes an Int8Array back into an approximate Float32Array.
 */
export function dequantizeFromInt8(vec: Int8Array): Float32Array {
  const len = vec.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = vec[i] * INT8_INV_SCALE;
  }
  return out;
}

/**
 * Computes asymmetric cosine similarity between a normalized Float32 query vector
 * and a quantized Int8 chunk vector.
 *
 * Since query is unit length (||q|| = 1.0),
 * cosine(q, c) = (q · c_fp32) / ||c_fp32|| = (sum(q_i * c_i) / 127) / (||c|| / 127) = sum(q_i * c_i) / ||c||.
 */
export function asymmetricCosineInt8(queryFp32: Float32Array, chunkInt8: Int8Array): number {
  const dim = queryFp32.length;
  let dot = 0.0;
  let normSq = 0.0;

  // Unroll loop in steps of 8 for performance
  let i = 0;
  const limit = dim - (dim % 8);
  for (; i < limit; i += 8) {
    const c0 = chunkInt8[i];
    const c1 = chunkInt8[i + 1];
    const c2 = chunkInt8[i + 2];
    const c3 = chunkInt8[i + 3];
    const c4 = chunkInt8[i + 4];
    const c5 = chunkInt8[i + 5];
    const c6 = chunkInt8[i + 6];
    const c7 = chunkInt8[i + 7];

    dot +=
      queryFp32[i] * c0 +
      queryFp32[i + 1] * c1 +
      queryFp32[i + 2] * c2 +
      queryFp32[i + 3] * c3 +
      queryFp32[i + 4] * c4 +
      queryFp32[i + 5] * c5 +
      queryFp32[i + 6] * c6 +
      queryFp32[i + 7] * c7;

    normSq +=
      c0 * c0 +
      c1 * c1 +
      c2 * c2 +
      c3 * c3 +
      c4 * c4 +
      c5 * c5 +
      c6 * c6 +
      c7 * c7;
  }

  for (; i < dim; i++) {
    const c = chunkInt8[i];
    dot += queryFp32[i] * c;
    normSq += c * c;
  }

  if (normSq <= 0) return 0.0;
  return dot / Math.sqrt(normSq);
}

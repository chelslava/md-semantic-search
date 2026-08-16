import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { tokenize } from '../src/lexical.mjs';
import { cosine } from '../src/core.mjs';
import { chunkMarkdownStructural } from '../src/markdown-parser.mjs';

const NUM_RUNS = 500;

// STOP words set for property assertion
const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'has', 'with', 'this', 'that', 'from',
  'not', 'but', 'you', 'your', 'can', 'all', 'any', 'its',
  'все', 'как', 'что', 'это', 'при', 'для', 'или', 'был', 'без', 'над',
  'под', 'так', 'его', 'нет', 'есть',
  'of', 'to', 'in', 'on', 'it', 'is', 'at', 'by', 'be', 'we', 'us', 'he',
  'as', 'or', 'an', 'do', 'so', 'no', 'if', 'up', 'my', 'me', 'am',
  'по', 'от', 'из', 'на', 'за', 'во', 'со', 'не', 'ни', 'же', 'ли', 'бы',
  'уж', 'мы', 'вы', 'он', 'то', 'но', 'до', 'ко',
]);

test('fuzz: tokenize() invariants hold for arbitrary string inputs', () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const tokens = tokenize(text);
      assert.ok(Array.isArray(tokens), 'tokenize must return an array');
      for (const token of tokens) {
        assert.equal(typeof token, 'string', 'each token must be a string');
        assert.ok(token.length > 1, `token "${token}" must have length > 1`);
        assert.equal(token, token.toLowerCase(), `token "${token}" must be lowercase`);
        assert.equal(STOP.has(token), false, `token "${token}" must not be a stop word`);
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

test('fuzz: cosine() mathematical properties hold for random float vectors', () => {
  fc.assert(
    fc.property(
      fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -100, max: 100 }), { minLength: 1, maxLength: 256 }),
      (rawVec) => {
        // L2-normalize the vector
        let sumSq = 0;
        for (let i = 0; i < rawVec.length; i++) sumSq += rawVec[i] * rawVec[i];
        const norm = Math.sqrt(sumSq) || 1;
        const vec = new Float32Array(rawVec.length);
        for (let i = 0; i < rawVec.length; i++) vec[i] = rawVec[i] / norm;

        if (sumSq > 1e-10) {
          // Property 1: self cosine similarity of non-zero normalized vector is approx 1.0
          const selfSim = cosine(vec, vec);
          assert.ok(
            Math.abs(selfSim - 1.0) < 1e-4,
            `self cosine similarity should be 1.0 (got ${selfSim})`
          );
        }

        // Property 2: cosine similarity of zero vector or zero buffer is non-NaN finite
        const zeroVec = new Float32Array(rawVec.length).fill(0);
        const zeroSim = cosine(vec, zeroVec);
        assert.equal(Number.isFinite(zeroSim), true, 'cosine with zero vector must produce finite number');
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('fuzz: cosine() symmetry holds for pairs of normalized vectors', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 128 }).chain((len) =>
        fc.tuple(
          fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -10, max: 10 }), { minLength: len, maxLength: len }),
          fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -10, max: 10 }), { minLength: len, maxLength: len })
        )
      ),
      ([arrA, arrB]) => {
        const a = new Float32Array(arrA);
        const b = new Float32Array(arrB);
        const simAB = cosine(a, b);
        const simBA = cosine(b, a);
        assert.equal(Number.isFinite(simAB), true);
        assert.equal(Number.isFinite(simBA), true);
        assert.ok(
          Math.abs(simAB - simBA) < 1e-5,
          `cosine symmetry failed: ${simAB} vs ${simBA}`
        );
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('fuzz: chunkMarkdownStructural() invariants hold for arbitrary markdown text', () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.integer({ min: 200, max: 2000 }),
      (text, maxChunk) => {
        const chunks = chunkMarkdownStructural(text, { maxChunk });
        assert.ok(Array.isArray(chunks), 'must return array of chunks');
        for (const chunk of chunks) {
          assert.equal(typeof chunk.text, 'string', 'chunk text must be a string');
          assert.equal(typeof chunk.heading, 'string', 'chunk heading must be a string');
          assert.ok(Array.isArray(chunk.headingPath), 'chunk headingPath must be an array');
          assert.ok(chunk.startLine >= 1, 'startLine must be >= 1');
          assert.ok(chunk.endLine >= chunk.startLine, 'endLine must be >= startLine');
        }
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

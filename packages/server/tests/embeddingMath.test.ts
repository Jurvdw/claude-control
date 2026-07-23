import { describe, it, expect } from 'vitest';
import { packEmbedding, unpackEmbedding, cosineSimilarity } from '../src/lib/embeddingMath.js';

describe('packEmbedding / unpackEmbedding', () => {
  it('round-trips a small Float32Array through Buffer without precision loss', () => {
    const original = new Float32Array([0.1, -0.5, 3.25, 0, 1.0, -1.0]);
    const packed = packEmbedding(original);
    expect(packed).toBeInstanceOf(Buffer);
    expect(packed.byteLength).toBe(original.byteLength);
    const unpacked = unpackEmbedding(packed);
    expect(Array.from(unpacked)).toEqual(Array.from(original));
  });

  it('round-trips a full 384-dim vector', () => {
    const original = new Float32Array(384);
    for (let i = 0; i < 384; i++) original[i] = Math.sin(i) * 0.5;
    const unpacked = unpackEmbedding(packEmbedding(original));
    expect(unpacked.length).toBe(384);
    expect(Array.from(unpacked)).toEqual(Array.from(original));
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('ranks a closer vector above a farther one for the same query', () => {
    const query = new Float32Array([1, 0, 0]);
    const close = new Float32Array([0.9, 0.1, 0]);
    const far = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(query, close)).toBeGreaterThan(cosineSimilarity(query, far));
  });

  it('returns 0 for a zero vector instead of dividing by zero', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(Number.isNaN(cosineSimilarity(a, b))).toBe(false);
  });
});

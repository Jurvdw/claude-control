// Pure vector math for Brain note embeddings — no I/O, no model, no Prisma.
// Kept separate from lib/embeddings.ts (which owns the actual model + DB
// writes) so this half is trivially unit-testable without mocking anything.

/**
 * Pack a Float32Array into a Buffer for storage in BrainNote.embedding.
 * Copies into a fresh ArrayBuffer rather than viewing the source's buffer
 * directly, so the returned Buffer's lifetime is independent of the caller's
 * typed array.
 */
export function packEmbedding(vec: Float32Array): Buffer {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  return Buffer.from(bytes);
}

/**
 * Unpack a Buffer (as read back from Postgres via Prisma) into a
 * Float32Array. Slices into a fresh ArrayBuffer first: a Node Buffer read
 * from a driver may be a view into a pooled allocation whose byteOffset
 * isn't a multiple of 4, which Float32Array requires.
 */
export function unpackEmbedding(buf: Buffer): Float32Array {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(arrayBuffer);
}

/** Cosine similarity in [-1, 1]. Returns 0 (not NaN) if either vector is all zeros. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

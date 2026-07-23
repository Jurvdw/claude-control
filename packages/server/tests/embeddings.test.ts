import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeVector = new Float32Array(384).fill(0.1);

// The real model is a ~90MB download — never touch it in a unit test. Fake
// the pipeline factory to return a stub extractor with the same call shape.
// `env` is a plain mutable object in the real library (embeddings.ts writes
// env.cacheDir at module load) — stub it the same shape so that write is a
// harmless no-op here instead of throwing on an undefined export.
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => async (_text: string, _opts: Record<string, unknown>) => ({ data: fakeVector })),
  env: { cacheDir: '' },
}));

const updateCalls: Array<{ where: unknown; data: unknown }> = [];
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    brainNote: {
      update: vi.fn(async (args: { where: unknown; data: unknown }) => {
        updateCalls.push(args);
        return { id: 'note1' };
      }),
    },
  },
}));

import { embedText, embedAndStoreNote } from '../src/lib/embeddings.js';
import { prisma } from '../src/lib/prisma.js';

beforeEach(() => {
  updateCalls.length = 0;
});

describe('embedText', () => {
  it('returns a 384-dim Float32Array from the model pipeline output', async () => {
    const vec = await embedText('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });
});

describe('embedAndStoreNote', () => {
  it('embeds title+summary+content and stores it packed on the note', async () => {
    await embedAndStoreNote('note1', 'Title', 'Summary', 'Content');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].where).toEqual({ id: 'note1' });
    const data = updateCalls[0].data as { embedding: Buffer };
    expect(data.embedding).toBeInstanceOf(Buffer);
    expect(data.embedding.byteLength).toBe(384 * 4);
  });

  it('never throws even if the DB write fails', async () => {
    vi.mocked(prisma.brainNote.update).mockRejectedValueOnce(new Error('db down'));
    await expect(embedAndStoreNote('note1', 'T', 'S', 'C')).resolves.toBeUndefined();
  });
});

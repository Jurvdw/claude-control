import { describe, it, expect, vi } from 'vitest';
import { packEmbedding } from '../src/lib/embeddingMath.js';
import type { ToolContext } from '../src/tools/registry.js';

const noteClose = { title: 'Close', folder: '', summary: 'closest', embedding: packEmbedding(new Float32Array([1, 0, 0])) };
const noteMid = { title: 'Mid', folder: '', summary: 'middle', embedding: packEmbedding(new Float32Array([0.7, 0.7, 0])) };
const noteFar = { title: 'Far', folder: '', summary: 'farthest', embedding: packEmbedding(new Float32Array([0, 1, 0])) };

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    // vi.fn() (not a plain async function) so the second test below can
    // override its resolved value for one call via mockResolvedValueOnce.
    // Deliberately returned out of similarity order — the tool must sort, not pass through.
    brainNote: { findMany: vi.fn(async () => [noteFar, noteClose, noteMid]) },
  },
}));

vi.mock('../src/lib/embeddings.js', () => ({
  // Query vector identical to noteClose's — Close should rank first.
  embedText: async () => new Float32Array([1, 0, 0]),
}));

import { prisma } from '../src/lib/prisma.js';
import { getTool } from '../src/tools/registry.js';
import '../src/tools/brain.js'; // side effect: registers all tools in this file

describe('search_brain_semantic', () => {
  it('ranks notes by cosine similarity to the query, closest first', async () => {
    const tool = getTool('search_brain_semantic');
    expect(tool).toBeDefined();
    const ctx: ToolContext = { serverId: 's1', agent: { id: 'a1' } as never, ownerUserId: 'u1' };
    const result = await tool!.execute({ query: 'anything' }, ctx);
    const lines = result.split('\n');
    expect(lines[0]).toContain('Close');
    expect(lines[1]).toContain('Mid');
    expect(lines[2]).toContain('Far');
  });

  it('reports plainly when no notes have embeddings yet', async () => {
    vi.mocked(prisma.brainNote.findMany).mockResolvedValueOnce([]);
    const tool = getTool('search_brain_semantic');
    const ctx: ToolContext = { serverId: 's1', agent: { id: 'a1' } as never, ownerUserId: 'u1' };
    const result = await tool!.execute({ query: 'anything' }, ctx);
    expect(result).toMatch(/no brain notes/i);
  });
});

import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';

// Versioned cache of the compact Brain index (titles + one-line summaries) that
// every agent run injects into its system prompt. Before this, each run
// re-queried brainNote + rebuilt the string even when the Brain hadn't changed.
//
// Invalidation is event-driven: every Brain write broadcasts `brain.updated`, so
// edits appear on the next run instantly. A short TTL is a backstop for the rare
// write path that doesn't emit (e.g. a direct delete), so the cache self-heals.

interface Entry {
  text: string;
  builtAt: number;
}

const cache = new Map<string, Entry>();
const TTL_MS = 30_000;

/** Drop a server's cached Brain index (call after any Brain mutation). */
export function invalidateBrainIndex(serverId: string): void {
  cache.delete(serverId);
}

// Any broadcast Brain write invalidates the cache (covers create/update/upsert/import).
bus.on('brain.updated', (e) => invalidateBrainIndex(e.serverId));

function buildIndex(notes: Array<{ folder: string | null; title: string; summary: string | null }>): string {
  if (notes.length === 0) return '(empty — no Brain notes yet)';
  return notes
    .map((n) => `- ${n.folder ? n.folder + '/' : ''}${n.title}: ${n.summary || '(no summary)'}`)
    .join('\n');
}

/** The formatted Brain index for a server, served from cache when unchanged. */
export async function getBrainIndex(serverId: string): Promise<string> {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.builtAt < TTL_MS) return hit.text;

  const notes = await prisma.brainNote.findMany({
    where: { serverId },
    select: { folder: true, title: true, summary: true },
    take: 200,
    orderBy: { updatedAt: 'desc' },
  });
  const text = buildIndex(notes);
  cache.set(serverId, { text, builtAt: Date.now() });
  return text;
}

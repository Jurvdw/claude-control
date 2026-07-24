import type { Prisma } from '@prisma/client';

/**
 * Builds `findMany` args for "the most recent `limit` messages matching
 * `where`, optionally older than `before`". Always orders DESC (newest
 * first) so a channel/thread with more than `limit` messages returns the
 * newest slice, not the oldest — the caller MUST reverse the result rows
 * back to ascending order before returning them to the client, via
 * `toChronological`.
 */
export function buildRecentMessagesArgs(
  where: Prisma.MessageWhereInput,
  before: string | undefined,
  limit: number,
  select: Prisma.MessageSelect,
) {
  return {
    where: {
      ...where,
      ...(before && { createdAt: { lt: new Date(before) } }),
    },
    orderBy: { createdAt: 'desc' as const },
    take: limit,
    select,
  };
}

/** Reverse DESC-ordered rows back to ascending (oldest-first) for display. */
export function toChronological<T>(rows: T[]): T[] {
  return [...rows].reverse();
}

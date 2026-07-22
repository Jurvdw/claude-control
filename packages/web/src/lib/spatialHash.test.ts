import { describe, it, expect } from 'vitest';
import { spatialHashPairs, type HashedPoint } from './spatialHash';

// Brute-force O(n²) reference: every unordered pair, no distance filtering.
// Used to check spatialHashPairs doesn't MISS a pair that's actually close.
function bruteForcePairsWithinDistance(points: HashedPoint[], maxDist: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      if (Math.sqrt(dx * dx + dy * dy) <= maxDist) {
        out.add(pairKey(points[i].id, points[j].id));
      }
    }
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function toKeySet(pairs: Array<[string, string]>): Set<string> {
  const s = new Set<string>();
  for (const [a, b] of pairs) s.add(pairKey(a, b));
  return s;
}

describe('spatialHashPairs', () => {
  it('returns no pairs for a single point', () => {
    const points: HashedPoint[] = [{ id: 'a', x: 0, y: 0 }];
    expect(spatialHashPairs(points, 100)).toEqual([]);
  });

  it('returns no pairs for an empty point list', () => {
    expect(spatialHashPairs([], 100)).toEqual([]);
  });

  it('returns no pairs for two points far apart (different, non-adjacent cells)', () => {
    const points: HashedPoint[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 1000 },
    ];
    expect(spatialHashPairs(points, 100)).toEqual([]);
  });

  it('returns exactly one pair for two points in the same cell', () => {
    const points: HashedPoint[] = [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 20, y: 20 },
    ];
    const pairs = spatialHashPairs(points, 100);
    expect(pairs).toHaveLength(1);
    expect(toKeySet(pairs)).toEqual(new Set([pairKey('a', 'b')]));
  });

  it('returns exactly one pair for two points in horizontally adjacent cells', () => {
    // cellSize 100: 'a' in cell (0,0), 'b' in cell (1,0).
    const points: HashedPoint[] = [
      { id: 'a', x: 50, y: 50 },
      { id: 'b', x: 150, y: 50 },
    ];
    const pairs = spatialHashPairs(points, 100);
    expect(pairs).toHaveLength(1);
    expect(toKeySet(pairs)).toEqual(new Set([pairKey('a', 'b')]));
  });

  it('never returns duplicate pairs and never pairs a point with itself', () => {
    const points: HashedPoint[] = [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 15, y: 15 },
      { id: 'c', x: 12, y: 18 },
    ];
    const pairs = spatialHashPairs(points, 100);
    const keys = pairs.map(([x, y]) => pairKey(x, y));
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    for (const [x, y] of pairs) expect(x).not.toBe(y); // no self-pairs
  });

  it('matches a brute-force scan for a dense cluster (no missed near-pairs)', () => {
    // 8 points packed inside one 100x100 cell, cellSize 100 — every pair is
    // "same cell" and must appear in both the brute-force set and the result.
    const points: HashedPoint[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      x: 10 + i * 10,
      y: 10 + (i % 3) * 20,
    }));
    const expected = bruteForcePairsWithinDistance(points, 1000); // all pairs, generous radius
    const actual = toKeySet(spatialHashPairs(points, 100));
    expect(actual).toEqual(expected);
  });

  it('throws for a non-positive cellSize', () => {
    expect(() => spatialHashPairs([{ id: 'a', x: 0, y: 0 }], 0)).toThrow();
    expect(() => spatialHashPairs([{ id: 'a', x: 0, y: 0 }], -5)).toThrow();
  });
});

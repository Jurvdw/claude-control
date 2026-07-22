export interface HashedPoint {
  id: string;
  x: number;
  y: number;
}

// Half of the 8 surrounding-cell offsets (plus the implicit same-cell case,
// handled separately) — enough to visit every unordered pair of distinct
// cells in a 3x3 neighborhood exactly once. Using all 8 would double-count
// every cross-cell pair (once from each cell's perspective).
const FORWARD_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Buckets points into a uniform grid of `cellSize` and returns every
 * candidate near-pair (same cell, or one of the 8 surrounding cells) exactly
 * once. Pairs farther apart than that are omitted — a legitimate
 * approximation for force simulations where influence falls off with
 * distance, not a correctness bug.
 */
export function spatialHashPairs(points: HashedPoint[], cellSize: number): Array<[string, string]> {
  if (cellSize <= 0) throw new Error('spatialHashPairs: cellSize must be > 0');

  const cellOf = (v: number) => Math.floor(v / cellSize);
  const buckets = new Map<string, HashedPoint[]>();
  for (const p of points) {
    const key = `${cellOf(p.x)},${cellOf(p.y)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }

  const pairs: Array<[string, string]> = [];
  for (const [key, bucket] of buckets) {
    const [cxStr, cyStr] = key.split(',');
    const cx = Number(cxStr);
    const cy = Number(cyStr);

    // Pairs within the same cell.
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        pairs.push([bucket[i].id, bucket[j].id]);
      }
    }

    // Pairs against each forward-only neighbor cell.
    for (const [dx, dy] of FORWARD_NEIGHBOR_OFFSETS) {
      const neighborBucket = buckets.get(`${cx + dx},${cy + dy}`);
      if (!neighborBucket) continue;
      for (const a of bucket) {
        for (const b of neighborBucket) {
          pairs.push([a.id, b.id]);
        }
      }
    }
  }
  return pairs;
}

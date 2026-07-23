# Brain Graph Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(n²) pairwise repulsion loop in the Brain graph's force simulation with a grid-based spatial hash, so the common case (nodes roughly uniformly spread across the canvas) runs in ~O(n).

**Architecture:** A new pure function, `spatialHashPairs`, buckets node positions into a uniform grid and returns only the candidate pairs that could meaningfully repel each other (same cell or one of 4 canonical "forward" neighbor cells — visiting each unordered cell-pair exactly once). `BrainGraph.tsx`'s repulsion pass calls this once per animation frame instead of the current full double loop, then applies the exact same force math as today to each returned pair.

**Tech Stack:** TypeScript, React (`BrainGraph.tsx` is unmodified in structure, only its repulsion loop changes), Vitest (net-new to `packages/web` — this package currently has zero test infrastructure; Task 1 adds it).

## Global Constraints

- No change to the simulation's visual behavior or tuning constants (the `rep = 3200 / d2` formula, damping, centering force, edge-attraction pass) — only which pairs get evaluated changes, not how force is computed per pair.
- The optimization only needs to hold up through the low thousands of nodes — no requirement to handle arbitrarily large graphs.
- Edge attraction (`for (const e of edges)`, the loop immediately after repulsion in `BrainGraph.tsx`) is out of scope — already O(edges), untouched.

---

### Task 1: `spatialHashPairs` pure function + Vitest setup for `packages/web`

**Files:**
- Create: `packages/web/src/lib/spatialHash.ts`
- Create: `packages/web/src/lib/spatialHash.test.ts`
- Modify: `packages/web/package.json` (add `vitest` devDependency + `test` script)
- Modify: `packages/web/vite.config.ts` (switch `defineConfig` import to `vitest/config`, add `test` block)

**Interfaces:**
- Produces: `export interface HashedPoint { id: string; x: number; y: number }` and `export function spatialHashPairs(points: HashedPoint[], cellSize: number): Array<[string, string]>` — returns each candidate near-pair of ids exactly once (no duplicates, no self-pairs, no `[b, a]` alongside `[a, b]`). A pair is candidate if both points fall in the same grid cell, or in cells adjacent (including diagonally) under the given `cellSize`. Throws if `cellSize <= 0`.

`packages/web` currently has no test runner at all (confirmed: no `vitest` in `package.json`, no `*.test.ts` files anywhere in `packages/web/src`, `package.json` scripts are only `dev`/`build`/`preview`/`lint`). This task adds it, scoped minimally — no DOM/jsdom environment needed since this first test file exercises a plain-data function, no React/browser APIs.

- [ ] **Step 1: Add Vitest to `packages/web`**

Edit `packages/web/package.json` — add to `devDependencies` (alongside the existing `vite: ^6.0.7`, keep alphabetical order with the existing list):

```json
    "vitest": "^2.1.9",
```

Add a `test` script (alongside the existing `dev`/`build`/`preview`/`lint` scripts):

```json
    "test": "vitest run",
```

Run: `npm install` (from repo root — this is an npm workspaces monorepo, installing at the root links `packages/web`'s new devDependency)
Expected: install completes with no errors, `packages/web/node_modules/.bin/vitest` (or the hoisted root equivalent) exists.

- [ ] **Step 2: Wire Vitest into the existing Vite config**

Replace the full contents of `packages/web/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev server proxies API + socket to the backend so the web app can use
// same-origin relative URLs and cookies work without CORS headaches.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:4000',
      '/servers': 'http://localhost:4000',
      '/api-keys': 'http://localhost:4000',
      '/provider': 'http://localhost:4000',
      '/invites': 'http://localhost:4000',
      '/agent-templates': 'http://localhost:4000',
      '/tools': 'http://localhost:4000',
      '/notifications': 'http://localhost:4000',
      '/usage': 'http://localhost:4000',
      '/files': 'http://localhost:4000',
      '/webhooks': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
  },
});
```

(Only two changes from the current file: the `defineConfig` import comes from `vitest/config` instead of `vite` — this is Vitest's documented way to type-check a shared config's `test` block without a separate config file — and the new `test: { environment: 'node' }` block. `environment: 'node'` is correct here since this first test suite touches no DOM/React; a component-testing setup, if ever needed, would override this per-file or add `jsdom` later — out of scope for this plan.)

Run: `cd packages/web && npx vitest run`
Expected: `No test files found` (or similar) — confirms Vitest itself is wired up and runs, before any test file exists yet.

- [ ] **Step 3: Write the failing tests**

Create `packages/web/src/lib/spatialHash.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/lib/spatialHash.test.ts`
Expected: FAIL — `Cannot find module './spatialHash'` (the module doesn't exist yet).

- [ ] **Step 5: Write the implementation**

Create `packages/web/src/lib/spatialHash.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/lib/spatialHash.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 7: Commit**

```bash
git add packages/web/package.json packages/web/vite.config.ts packages/web/src/lib/spatialHash.ts packages/web/src/lib/spatialHash.test.ts
git commit -m "Add spatial-hash neighbor pairing + Vitest setup for packages/web"
```

---

### Task 2: Wire `spatialHashPairs` into `BrainGraph.tsx`'s repulsion loop

**Files:**
- Modify: `packages/web/src/components/BrainGraph.tsx:1-2` (imports), `:114-137` (the force-simulation `useEffect` — specifically the repulsion double-loop at lines 121-137)

**Interfaces:**
- Consumes: `spatialHashPairs(points: HashedPoint[], cellSize: number): Array<[string, string]>` and `HashedPoint` from Task 1's `packages/web/src/lib/spatialHash.ts`.

Current code (`BrainGraph.tsx:114-137`), for reference — this is what gets replaced:

```ts
  // Force simulation loop.
  useEffect(() => {
    const ids = nodes.map((n) => n.id);
    const step = () => {
      const pos = posRef.current;
      const alpha = alphaRef.current;

      for (let i = 0; i < ids.length; i++) {
        const a = pos.get(ids[i]);
        if (!a) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = pos.get(ids[j]);
          if (!b) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const rep = 3200 / d2;
          const fx = (dx / d) * rep;
          const fy = (dy / d) * rep;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
```

There is no existing automated test covering this component's simulation behavior (it's a canvas-like SVG animation loop, manually/visually verified per the project's established convention for this file — see the design spec's Testing note for §1). This task is verified by a manual before/after visual check plus `tsc --noEmit`, not a new automated test — do not invent one that mocks `requestAnimationFrame` and asserts on internal `Map` state; that would test implementation details, not behavior, and this codebase doesn't do that for this file.

- [ ] **Step 1: Add the import**

In `packages/web/src/components/BrainGraph.tsx`, change line 1-3 from:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { GraphNode, GraphEdge } from '../lib/types';
```

to:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { GraphNode, GraphEdge } from '../lib/types';
import { spatialHashPairs, type HashedPoint } from '../lib/spatialHash';
```

- [ ] **Step 2: Add the cell-size constant**

Directly above the `export default function BrainGraph` line (after the existing `folderColor` function, before the component), add:

```ts
// Grid cell size for the repulsion spatial hash. Derived from the existing
// `rep = 3200 / d2` force formula: force drops to ~0.5 (negligible next to
// the ~1-5 unit centering/damping forces applied per tick) at d = sqrt(3200
// / 0.5) ≈ 80; cell size is 1.5x that distance so each node's 3x3
// neighborhood comfortably covers every pair still worth computing.
const REPULSION_CELL_SIZE = 120;
```

- [ ] **Step 3: Replace the repulsion double-loop**

In the `useEffect` at `BrainGraph.tsx:115` (`// Force simulation loop.`), replace:

```ts
      for (let i = 0; i < ids.length; i++) {
        const a = pos.get(ids[i]);
        if (!a) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = pos.get(ids[j]);
          if (!b) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const rep = 3200 / d2;
          const fx = (dx / d) * rep;
          const fy = (dy / d) * rep;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
```

with:

```ts
      const hashPoints: HashedPoint[] = [];
      for (const id of ids) {
        const p = pos.get(id);
        if (p) hashPoints.push({ id, x: p.x, y: p.y });
      }
      for (const [idA, idB] of spatialHashPairs(hashPoints, REPULSION_CELL_SIZE)) {
        const a = pos.get(idA);
        const b = pos.get(idB);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const rep = 3200 / d2;
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
```

Note this drops the now-unused `ids[i]`/`ids[j]` indexing pattern but keeps `const ids = nodes.map((n) => n.id);` above it — `ids` is still used to build `hashPoints` and later in the file (the centering/damping loop at the old line 153, `for (const id of ids)`). Do not remove that declaration.

- [ ] **Step 4: Typecheck**

Run: `cd packages/web && npm run lint`
Expected: exits 0, no TypeScript errors (`lint` is `tsc --noEmit` for this package).

- [ ] **Step 5: Manual visual verification**

Run: `npm run dev` (from repo root — starts both server and web per the existing `dev` script)
Then in the running app: open a workspace with Brain notes (create a few with `[[wikilinks]]` between them if none exist), open the Brain graph view, and confirm:
- The graph still lays out and settles the same way it did before (same spread, same clustering by folder color, same edge lengths) — no visibly different force behavior.
- Dragging a node still repels its neighbors correctly.
- No console errors.

This is a manual check, not an automated one — record the result in the task's commit message or PR description rather than adding a test file.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/BrainGraph.tsx
git commit -m "Replace O(n^2) brain-graph repulsion with a spatial-hash pass"
```

---

## Self-Review Notes

- **Spec coverage:** §1's every bullet is covered — grid rebuilt fresh each frame (Task 2 rebuilds `hashPoints`/calls `spatialHashPairs` every `step()` invocation, no caching across frames), cell size derived from the existing force formula (Task 2 Step 2's comment shows the derivation), edge-attraction pass left untouched (never modified in either task), no change to visual tuning constants (`3200`, damping, centering — all untouched, only which pairs are visited changes), unit tests for the spatial-hash function only (Task 1), the repulsion-loop wiring itself verified manually (Task 2 Step 5) rather than with a new automated test — matching the spec's explicit Testing note for this section.
- **Placeholder scan:** none found — every step has complete, real code or an exact command + expected output.
- **Type/signature consistency:** `HashedPoint { id: string; x: number; y: number }` and `spatialHashPairs(points: HashedPoint[], cellSize: number): Array<[string, string]>` are identical between Task 1's Interfaces block, its implementation, and Task 2's import/usage. `REPULSION_CELL_SIZE` is defined once (Task 2 Step 2) and used once (Task 2 Step 3).

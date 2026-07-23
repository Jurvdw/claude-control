# Semantic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Brain recall a meaning-based search alongside its existing keyword search, using a local (no API key, no per-call cost) embedding model.

**Architecture:** A local ONNX sentence-embedding model (`@xenova/transformers`, `Xenova/all-MiniLM-L6-v2`, 384-dim) runs in the Node server process. Every `BrainNote` create/update also computes and stores an embedding (`Bytes` column, packed `Float32Array`). A new `search_brain_semantic` tool ranks a workspace's notes by cosine similarity to a query, computed brute-force in Node at query time (no vector DB — vault sizes are small enough that this is trivially fast).

**Tech Stack:** TypeScript, Prisma, Express, Vitest, `@xenova/transformers`.

## Global Constraints

- No vector database, no `pgvector` — the bundled `embedded-postgres` binary doesn't ship it. Brute-force cosine similarity in Node only.
- No external embeddings API, no new credential type — embedding runs fully local in-process.
- Schema changes are additive only: `Bytes?` (nullable), no `NOT NULL`, no default required — via the `ADDITIVE_SQL` template string in `packages/server/src/db/embedded.ts`, matching every other post-baseline column/table in that file.
- `search_brain_semantic` is a **new, separate tool** — `search_brain` (existing keyword tool) is untouched.
- Embedding computation on write is fire-and-forget relative to the note write it follows: it must never throw, and a caller does not need to `await` it for the note write itself to succeed.
- Pre-existing notes are not backfilled — `embedding IS NULL` notes are simply excluded from semantic results.
- `packages/server` is ESM (`"type": "module"`), imports use explicit `.js` extensions, tests run via `vitest run` (`npm run test -w @cc/server` from repo root, or `npm test` from `packages/server`).
- Follow this codebase's existing mock convention for tests that touch Prisma or Node built-ins: `vi.mock('../src/lib/prisma.js', () => ({ prisma: { <model>: { <method>: async () => ... } } }))` — mock only the specific methods used (see `packages/server/tests/coding.test.ts` for the precedent).

---

## File Structure

- **Modify:** `packages/server/prisma/schema.prisma` — add `embedding Bytes?` to `BrainNote`.
- **Modify:** `packages/server/src/db/embedded.ts` — append the additive column to `ADDITIVE_SQL`.
- **Create:** `packages/server/src/lib/embeddingMath.ts` — pure functions: pack/unpack, cosine similarity. Zero external dependencies, fully unit-testable without mocks.
- **Create:** `packages/server/tests/embeddingMath.test.ts`
- **Create:** `packages/server/src/lib/embeddings.ts` — the model wrapper (`embedText`) and the write-path helper (`embedAndStoreNote`). Depends on `@xenova/transformers`, `lib/prisma.ts`, `lib/logger.ts`, `lib/embeddingMath.ts`.
- **Create:** `packages/server/tests/embeddings.test.ts`
- **Modify:** `packages/server/src/tools/brain.ts` — call `embedAndStoreNote` from `write_brain_note`'s direct-write branch; add the new `search_brain_semantic` tool.
- **Modify:** `packages/server/src/tools/capture.ts` — call `embedAndStoreNote` from both branches of `capture()`.
- **Modify:** `packages/server/src/routes/brain.ts` — call `embedAndStoreNote` from `POST /notes`, `PATCH /notes/:noteId`, and `POST /proposals/:id/approve`.
- **Modify:** `packages/server/src/workflows/engine.ts` — call `embedAndStoreNote` from the `brain.write` node case.
- **Create:** `packages/server/tests/search-brain-semantic.test.ts`
- **Modify:** `packages/server/package.json` — add `@xenova/transformers` dependency.

---

### Task 1: Schema — `embedding` column + dependency

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/prisma/schema.prisma` (`BrainNote` model, ~line 490)
- Modify: `packages/server/src/db/embedded.ts` (`ADDITIVE_SQL`, ~line 283)

**Interfaces:**
- Produces: `BrainNote.embedding: Buffer | null` on the generated Prisma Client — every later task that reads/writes a `BrainNote` relies on this field existing.

- [ ] **Step 1: Add the dependency**

In `packages/server/package.json`, the scoped (`@...`) packages are grouped first and sorted among themselves, then unscoped packages follow alphabetically. `@xenova/transformers` sorts after `@prisma/client` and before the unscoped group. Change:

```json
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@prisma/client": "^6.19.0",
    "argon2": "^0.44.0",
```

to:

```json
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@prisma/client": "^6.19.0",
    "@xenova/transformers": "^2.17.2",
    "argon2": "^0.44.0",
```

Run: `npm install -w @cc/server`
Expected: installs cleanly, `packages/server/node_modules/@xenova/transformers` exists.

- [ ] **Step 2: Add the Prisma field**

In `packages/server/prisma/schema.prisma`, in the `BrainNote` model:

```prisma
model BrainNote {
  id         String   @id @default(cuid())
  serverId   String
  server     Server   @relation(fields: [serverId], references: [id], onDelete: Cascade)
  folder     String   @default("") // e.g. "About", "People", "Style"
  title      String
  // One-line summary used in the compact Brain index (token efficiency).
  summary    String   @default("")
  content    String   @default("")
  // Packed Float32Array (384-dim, all-MiniLM-L6-v2). Null until computed;
  // never backfilled for pre-existing notes.
  embedding  Bytes?
  updatedBy  String? // userId or agentId
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  proposals BrainProposal[]

  @@index([serverId, folder])
  @@map("brain_notes")
}
```

(Only the `embedding Bytes?` line and its comment are new — every other line is unchanged, shown for exact placement.)

- [ ] **Step 3: Add the additive migration**

In `packages/server/src/db/embedded.ts`, inside the `ADDITIVE_SQL` template string, add a new line right after the existing `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3);` line (still inside the backticks, before the closing `` ` ``):

```sql
ALTER TABLE "brain_notes" ADD COLUMN IF NOT EXISTS "embedding" BYTEA;
```

- [ ] **Step 4: Regenerate the Prisma Client and build**

Run: `npm run db:generate -w @cc/server`
Expected: `Generated Prisma Client` with no errors.

Run: `npm run build -w @cc/server`
Expected: exits 0 — confirms the new `embedding: Buffer | null` field type-checks everywhere it's currently referenced (nowhere yet, so this just confirms the schema/client change alone compiles clean).

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json packages/server/package-lock.json packages/server/prisma/schema.prisma packages/server/src/db/embedded.ts
git commit -m "Add embedding column to BrainNote + @xenova/transformers dependency"
```

---

### Task 2: Pure embedding math — pack/unpack, cosine similarity

**Files:**
- Create: `packages/server/src/lib/embeddingMath.ts`
- Test: `packages/server/tests/embeddingMath.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, `Buffer`/`Float32Array` only — Node built-ins).
- Produces: `packEmbedding(vec: Float32Array): Buffer`, `unpackEmbedding(buf: Buffer): Float32Array`, `cosineSimilarity(a: Float32Array, b: Float32Array): number` — Task 3 and Task 5 both import these three names from `../lib/embeddingMath.js`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/embeddingMath.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @cc/server -- embeddingMath`
Expected: FAIL — `Cannot find module '../src/lib/embeddingMath.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/lib/embeddingMath.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @cc/server -- embeddingMath`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/embeddingMath.ts packages/server/tests/embeddingMath.test.ts
git commit -m "Add pure embedding pack/unpack + cosine similarity helpers"
```

---

### Task 3: Embedding generation + write-path helper

**Files:**
- Create: `packages/server/src/lib/embeddings.ts`
- Test: `packages/server/tests/embeddings.test.ts`

**Interfaces:**
- Consumes: `packEmbedding` from `../lib/embeddingMath.js` (Task 2); `prisma` from `../lib/prisma.js`; `logger` from `../lib/logger.js`.
- Produces: `embedText(text: string): Promise<Float32Array>`, `embedAndStoreNote(noteId: string, title: string, summary: string, content: string): Promise<void>` — Task 4 (write-path wiring) and Task 5 (`search_brain_semantic`) both import these from `../lib/embeddings.js`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/tests/embeddings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeVector = new Float32Array(384).fill(0.1);

// The real model is a ~90MB download — never touch it in a unit test. Fake
// the pipeline factory to return a stub extractor with the same call shape.
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => async (_text: string, _opts: Record<string, unknown>) => ({ data: fakeVector })),
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @cc/server -- embeddings.test`
Expected: FAIL — `Cannot find module '../src/lib/embeddings.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/lib/embeddings.ts`:

```ts
import { pipeline } from '@xenova/transformers';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { packEmbedding } from './embeddingMath.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Awaited<ReturnType<typeof pipeline>> rather than naming a library type
// directly — correct regardless of exactly what @xenova/transformers exports,
// since it's derived structurally from pipeline()'s own return type.
type Extractor = Awaited<ReturnType<typeof pipeline>>;

let extractorPromise: Promise<Extractor> | null = null;
function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    // feature-extraction task narrows pipeline()'s overload to a callable
    // that takes (text, options) and returns a tensor-like { data }.
    extractorPromise = pipeline('feature-extraction', MODEL);
  }
  return extractorPromise;
}

/**
 * Embed arbitrary text into a 384-dim vector using a local model — no API
 * key, no per-call network request. Loads the model once, lazily; the first
 * call in a process downloads ~90MB from Hugging Face and caches it on disk,
 * every call after (including in later runs) is fully offline.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array((output as { data: ArrayLike<number> }).data);
}

/**
 * Compute and persist a Brain note's embedding. Fire-and-forget from the
 * caller's perspective: never throws, so a slow or failed embedding never
 * blocks or breaks the note write it follows — callers call this without
 * awaiting (`void embedAndStoreNote(...)`). Errors are logged, not raised.
 */
export async function embedAndStoreNote(
  noteId: string,
  title: string,
  summary: string,
  content: string,
): Promise<void> {
  try {
    const vector = await embedText(`${title}\n${summary}\n${content}`);
    await prisma.brainNote.update({ where: { id: noteId }, data: { embedding: packEmbedding(vector) } });
  } catch (err) {
    logger.warn('brain note embedding failed', { noteId, error: (err as Error).message });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @cc/server -- embeddings.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/embeddings.ts packages/server/tests/embeddings.test.ts
git commit -m "Add local embedding generation + embedAndStoreNote write-path helper"
```

---

### Task 4: Wire embedding computation into every BrainNote write path

**Files:**
- Modify: `packages/server/src/tools/brain.ts` (`write_brain_note`, direct-write branch, ~line 94-107)
- Modify: `packages/server/src/tools/capture.ts` (`capture()`, both branches, ~line 137-153)
- Modify: `packages/server/src/routes/brain.ts` (`POST /notes` ~96-108, `PATCH /notes/:noteId` ~132-138, `POST /proposals/:id/approve` ~192-223)
- Modify: `packages/server/src/workflows/engine.ts` (`brain.write` case, ~line 235-246)

**Interfaces:**
- Consumes: `embedAndStoreNote` from `../lib/embeddings.js` (Task 3).
- Produces: nothing new for later tasks — this task's only job is calling an already-tested function from every place a `BrainNote`'s title/summary/content can change.

- [ ] **Step 1: `tools/brain.ts`**

Add the import at the top of `packages/server/src/tools/brain.ts`:

```ts
import { embedAndStoreNote } from '../lib/embeddings.js';
```

In `write_brain_note`'s direct-write branch (the code after the `if (policy === 'propose') { ... return ...; }` block), change:

```ts
    const note = await prisma.brainNote.upsert({
      where: {
        // no natural unique key; emulate by find-then-update
        id:
          (
            await prisma.brainNote.findFirst({
              where: { serverId: ctx.serverId, title, folder },
              select: { id: true },
            })
          )?.id ?? '__none__',
      },
      update: { summary, content, updatedBy: ctx.agent.id },
      create: { serverId: ctx.serverId, title, folder, summary, content, updatedBy: ctx.agent.id },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
    return `Wrote Brain note "${title}".`;
```

to:

```ts
    const note = await prisma.brainNote.upsert({
      where: {
        // no natural unique key; emulate by find-then-update
        id:
          (
            await prisma.brainNote.findFirst({
              where: { serverId: ctx.serverId, title, folder },
              select: { id: true },
            })
          )?.id ?? '__none__',
      },
      update: { summary, content, updatedBy: ctx.agent.id },
      create: { serverId: ctx.serverId, title, folder, summary, content, updatedBy: ctx.agent.id },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
    void embedAndStoreNote(note.id, note.title, note.summary, note.content);
    return `Wrote Brain note "${title}".`;
```

(The `propose` branch above it creates a `BrainProposal`, not a `BrainNote` — no embedding needed there; it's computed once the proposal is approved, in `routes/brain.ts` below.)

- [ ] **Step 2: `tools/capture.ts`**

Add the import at the top of `packages/server/src/tools/capture.ts`:

```ts
import { embedAndStoreNote } from '../lib/embeddings.js';
```

In `capture()`, change the `existing` branch:

```ts
    const note = await prisma.brainNote.update({
      where: { id: existing.id },
      data: { content: [...header, ...kept].join('\n').slice(0, 20000), updatedBy: ctx.agent.id },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
```

to:

```ts
    const note = await prisma.brainNote.update({
      where: { id: existing.id },
      data: { content: [...header, ...kept].join('\n').slice(0, 20000), updatedBy: ctx.agent.id },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
    void embedAndStoreNote(note.id, note.title, note.summary, note.content);
```

And the `else` (create) branch:

```ts
    const note = await prisma.brainNote.create({
      data: {
        serverId: ctx.serverId,
        folder: canon.folder,
        title: canon.title,
        summary: canon.summary,
        content: `# ${canon.title}\n\n${bullet}`,
        updatedBy: ctx.agent.id,
      },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
```

to:

```ts
    const note = await prisma.brainNote.create({
      data: {
        serverId: ctx.serverId,
        folder: canon.folder,
        title: canon.title,
        summary: canon.summary,
        content: `# ${canon.title}\n\n${bullet}`,
        updatedBy: ctx.agent.id,
      },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
    void embedAndStoreNote(note.id, note.title, note.summary, note.content);
```

- [ ] **Step 3: `routes/brain.ts`**

Add the import at the top of `packages/server/src/routes/brain.ts`:

```ts
import { embedAndStoreNote } from '../lib/embeddings.js';
```

In `POST /notes`, change:

```ts
    bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
    return res.status(201).json({ note });
```

to:

```ts
    bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
    void embedAndStoreNote(note.id, note.title, note.summary, note.content);
    return res.status(201).json({ note });
```

In `PATCH /notes/:noteId`, change:

```ts
    bus.emit('brain.updated', { serverId: req.membership!.serverId, note: updated });
    return res.json({ note: updated });
```

to:

```ts
    bus.emit('brain.updated', { serverId: req.membership!.serverId, note: updated });
    void embedAndStoreNote(updated.id, updated.title, updated.summary, updated.content);
    return res.json({ note: updated });
```

In `POST /proposals/:id/approve`, change:

```ts
      bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
      return res.json({ note });
```

to:

```ts
      bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
      void embedAndStoreNote(note.id, note.title, note.summary, note.content);
      return res.json({ note });
```

- [ ] **Step 4: `workflows/engine.ts`**

Add the import near the top of `packages/server/src/workflows/engine.ts` (alongside its existing `prisma`/`bus` imports):

```ts
import { embedAndStoreNote } from '../lib/embeddings.js';
```

In the `brain.write` case, change:

```ts
    case 'brain.write': {
      const title = String(d.title ?? 'Untitled');
      const folder = String(d.folder ?? '');
      const summary = String(d.summary ?? '');
      const content = tpl(d.content ?? '{{input}}', input);
      const existing = await prisma.brainNote.findFirst({ where: { serverId, title, folder }, select: { id: true } });
      const note = existing
        ? await prisma.brainNote.update({ where: { id: existing.id }, data: { summary, content } })
        : await prisma.brainNote.create({ data: { serverId, title, folder, summary, content } });
      bus.emit('brain.updated', { serverId, note });
      return { output: `Wrote Brain note "${title}"` };
    }
```

to:

```ts
    case 'brain.write': {
      const title = String(d.title ?? 'Untitled');
      const folder = String(d.folder ?? '');
      const summary = String(d.summary ?? '');
      const content = tpl(d.content ?? '{{input}}', input);
      const existing = await prisma.brainNote.findFirst({ where: { serverId, title, folder }, select: { id: true } });
      const note = existing
        ? await prisma.brainNote.update({ where: { id: existing.id }, data: { summary, content } })
        : await prisma.brainNote.create({ data: { serverId, title, folder, summary, content } });
      bus.emit('brain.updated', { serverId, note });
      void embedAndStoreNote(note.id, title, summary, content);
      return { output: `Wrote Brain note "${title}"` };
    }
```

- [ ] **Step 5: Run the full test suite — no new tests, this is a regression check**

Run: `npm test -w @cc/server`
Expected: PASS — every test passes, including all tests from Tasks 2 and 3 plus the full pre-existing suite. No failures introduced by these four call-site additions.

Run: `npm run build -w @cc/server`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/tools/brain.ts packages/server/src/tools/capture.ts packages/server/src/routes/brain.ts packages/server/src/workflows/engine.ts
git commit -m "Wire embedding computation into every BrainNote write path"
```

---

### Task 5: `search_brain_semantic` tool

**Files:**
- Modify: `packages/server/src/tools/brain.ts` (add the new tool, after the existing `search_brain` tool, ~line 139)
- Test: `packages/server/tests/search-brain-semantic.test.ts`

**Interfaces:**
- Consumes: `embedText` from `../lib/embeddings.js` (Task 3); `cosineSimilarity`, `unpackEmbedding` from `../lib/embeddingMath.js` (Task 2); `getTool` from `../tools/registry.js`.
- Produces: a registered tool named `search_brain_semantic` — no later task depends on it.

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/search-brain-semantic.test.ts`:

```ts
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
```

`vi.mock` calls are hoisted by Vitest above all imports in the file regardless of source order, so referencing `vi` inside the factory (via the `vi.fn()` wrapping `findMany`) is safe even though the `vi.mock(...)` calls appear before the `describe` block that imports things — this matches the hoisting behavior Vitest documents for `vi.mock`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @cc/server -- search-brain-semantic`
Expected: FAIL — `tool` is undefined (`search_brain_semantic` not yet registered), or a thrown error calling `.execute` on `undefined`.

- [ ] **Step 3: Write the implementation**

Add these two imports to the top of `packages/server/src/tools/brain.ts` (alongside the existing ones):

```ts
import { embedText } from '../lib/embeddings.js';
import { cosineSimilarity, unpackEmbedding } from '../lib/embeddingMath.js';
```

Add the new tool immediately after the existing `search_brain` tool (after its closing `});`, ~line 139):

```ts
// Search the Brain by meaning, not literal substring — complements search_brain.
registerTool({
  name: 'search_brain_semantic',
  description:
    'Search shared Brain notes by meaning rather than exact keywords — finds notes related to a ' +
    'concept even when they use different words. Returns matching titles + summaries, most relevant ' +
    'first. Try this when search_brain (literal substring match) comes up empty or the query is ' +
    'conceptual rather than a specific phrase.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  async execute(input, ctx) {
    const query = String(input.query);
    const notes = await prisma.brainNote.findMany({
      where: { serverId: ctx.serverId, embedding: { not: null } },
      select: { title: true, folder: true, summary: true, embedding: true },
    });
    if (notes.length === 0) return 'No Brain notes have semantic embeddings yet.';

    const queryVector = await embedText(query);
    const ranked = notes
      .map((n) => ({
        note: n,
        score: cosineSimilarity(queryVector, unpackEmbedding(n.embedding as Buffer)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return ranked.map(({ note: n }) => `- ${n.folder ? n.folder + '/' : ''}${n.title}: ${n.summary}`).join('\n');
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @cc/server -- search-brain-semantic`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Run the full suite**

Run: `npm test -w @cc/server`
Expected: PASS — every test in the package passes.

Run: `npm run build -w @cc/server`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/tools/brain.ts packages/server/tests/search-brain-semantic.test.ts
git commit -m "Add search_brain_semantic tool"
```

---

## Manual verification (not automatable — see spec §4 Testing)

The embedding model's actual output quality is not something to assert in CI, same category as "is the LLM's output good." After all five tasks are merged, manually verify once with the real model (first run downloads ~90MB):

1. Start the app, create two Brain notes with related but non-overlapping vocabulary (e.g. one about "car maintenance schedules" and one about "vehicle upkeep timing").
2. Ask an agent with `search_brain_semantic` enabled a question using neither note's exact wording, and confirm both surface, ranked sensibly.
3. Confirm `search_brain` (existing keyword tool) still behaves exactly as before — unaffected.

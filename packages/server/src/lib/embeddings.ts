import { pipeline } from '@xenova/transformers';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { packEmbedding } from './embeddingMath.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Awaited<ReturnType<typeof pipeline<'feature-extraction'>>> rather than
// naming a library type directly — correct regardless of exactly what
// @xenova/transformers exports, since it's derived structurally from
// pipeline()'s own return type. The explicit <'feature-extraction'>
// instantiation is required: pipeline() is a generic `pipeline<T extends
// PipelineType>`, and without pinning T, ReturnType resolves it against its
// full constraint (every pipeline task, not just this one), which produces a
// giant union whose call signature doesn't match a plain (text, options) call.
type Extractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

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
    const packed = packEmbedding(vector);
    // Type-only cast: Prisma's generated `Bytes` field type is
    // `Uint8Array<ArrayBuffer>` (TS 5.7+'s stricter typed-array generics),
    // but Node's `Buffer` (what packEmbedding returns, matching its own
    // tested contract in embeddingMath.ts) is declared as
    // `Uint8Array<ArrayBufferLike>` — a strict superset that includes
    // SharedArrayBuffer — so it isn't structurally assignable even though
    // packEmbedding's actual output is always backed by a real ArrayBuffer
    // (Buffer.from(Uint8Array) always allocates fresh, non-shared memory).
    // Cast, don't convert: converting at runtime (e.g. `new Uint8Array(packed)`)
    // would silently swap the stored value from a Buffer to a plain
    // Uint8Array, changing what callers read back from Prisma.
    await prisma.brainNote.update({
      where: { id: noteId },
      data: { embedding: packed as Uint8Array<ArrayBuffer> },
    });
  } catch (err) {
    logger.warn('brain note embedding failed', { noteId, error: (err as Error).message });
  }
}

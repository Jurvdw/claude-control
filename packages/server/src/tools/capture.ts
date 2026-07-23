import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import type { ToolContext } from './registry.js';
import { embedAndStoreNote } from '../lib/embeddings.js';

/**
 * Proactive capture: how agents remember durable things (voice, preferences,
 * decisions) without flooding the Brain or the token budget.
 *
 * The cost of a captured note is NOT the note — bodies are only read on demand.
 * It's the one line each note adds to the Brain index, which ships in the system
 * prompt of every run of every agent, forever. Freeform topics meant that line
 * count grew without bound.
 *
 * So capture is constrained on four axes, all enforced here in code rather than
 * asked for in a prompt (models comply with limits they cannot exceed):
 *
 *  1. FIXED TAXONOMY — six canonical notes, chosen from an enum. The Brain index
 *     grows by at most six lines total, no matter how much is captured.
 *  2. DEDUP — a normalised token-overlap check against existing lines. Restating
 *     a known fact in new words is a no-op.
 *  3. BUDGET — max 2 captures per run, 40 per server per day. A chatty agent
 *     cannot turn one conversation into fifty bullets.
 *  4. ROTATION — each note keeps its most recent MAX_LINES entries, so a note
 *     has a bounded size and old noise ages out.
 */

export type CaptureKind = 'style' | 'preference' | 'fact' | 'decision' | 'deadline' | 'project';

interface Canon {
  folder: string;
  title: string;
  summary: string;
}

// The complete set of notes proactive capture may ever create.
export const CANON: Record<CaptureKind, Canon> = {
  style: {
    folder: 'Style',
    title: 'Voice',
    summary: "How the Commander writes and talks — tone, phrasing, habits, formatting.",
  },
  preference: {
    folder: 'Commander',
    title: 'Preferences',
    summary: 'Standing likes, dislikes, and working preferences.',
  },
  fact: {
    folder: 'Commander',
    title: 'Facts',
    summary: 'Durable facts about the Commander and their world (names, IDs, context).',
  },
  decision: { folder: 'Decisions', title: 'Log', summary: 'Decisions made, with the date they were made.' },
  deadline: { folder: 'Deadlines', title: 'Log', summary: 'Commitments and dates to honour.' },
  project: { folder: 'Projects', title: 'Context', summary: 'Ongoing project context and constraints.' },
};

const MAX_LINES = 60; // per canonical note
const PER_RUN = 2;
const PER_DAY = 40;

// Per-run capture counts. Runs are short-lived and single-process, so a Map with
// opportunistic pruning is enough — no need to persist this.
const runCounts = new Map<string, { n: number; at: number }>();
function bumpRun(runId: string): number {
  const now = Date.now();
  for (const [k, v] of runCounts) if (now - v.at > 3_600_000) runCounts.delete(k);
  const cur = runCounts.get(runId) ?? { n: 0, at: now };
  cur.n += 1;
  cur.at = now;
  runCounts.set(runId, cur);
  return cur.n;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'in', 'on', 'for', 'that', 'it', 'his', 'her', 'their', 'they', 'commander', 'user', 'prefers', 'likes']);

/** Content words of a line, lowercased — the basis for duplicate detection. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/^-\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '') // strip our bullet + datestamp
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Overlap of the smaller token set — catches restatements, not just exact repeats. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

const DUPLICATE_AT = 0.8;

export interface CaptureResult {
  ok: boolean;
  message: string;
}

export async function capture(kind: CaptureKind, info: string, ctx: ToolContext): Promise<CaptureResult> {
  const text = info.trim().replace(/\s+/g, ' ');
  if (text.length < 8) return { ok: false, message: 'Too short to be worth remembering.' };

  // Budget — per run first (cheapest check, no query).
  if (ctx.runId && bumpRun(ctx.runId) > PER_RUN) {
    return { ok: false, message: `Capture budget for this run is used up (${PER_RUN}). Keep going; note only the single most valuable thing next time.` };
  }

  const canon = CANON[kind];
  const existing = await prisma.brainNote.findFirst({
    where: { serverId: ctx.serverId, folder: canon.folder, title: canon.title },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const bullet = `- (${stamp}) ${text}`;

  if (existing) {
    const lines = existing.content.split('\n').filter((l) => l.trim().startsWith('- '));

    // Dedup against what we already know.
    const incoming = tokens(text);
    for (const line of lines) {
      if (similarity(incoming, tokens(line)) >= DUPLICATE_AT) {
        return { ok: false, message: 'Already known — nothing captured (this is fine, not an error).' };
      }
    }

    // Daily cap, counted from this note's own datestamps.
    const today = lines.filter((l) => l.includes(`(${stamp})`)).length;
    if (today >= PER_DAY) return { ok: false, message: 'Daily capture cap reached for this category.' };

    const header = existing.content.split('\n').filter((l) => !l.trim().startsWith('- '));
    const kept = [...lines, bullet].slice(-MAX_LINES); // rotate: newest win
    const note = await prisma.brainNote.update({
      where: { id: existing.id },
      data: { content: [...header, ...kept].join('\n').slice(0, 20000), updatedBy: ctx.agent.id },
    });
    bus.emit('brain.updated', { serverId: ctx.serverId, note });
    void embedAndStoreNote(note.id, note.title, note.summary, note.content);
  } else {
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
  }

  return { ok: true, message: `Noted under ${canon.folder}/${canon.title}.` };
}

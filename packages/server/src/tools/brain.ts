import { prisma } from '../lib/prisma.js';
import { bus } from '../realtime/bus.js';
import { registerTool } from './registry.js';
import { outgoingLinks, computeBacklinks } from '../lib/wikilinks.js';
import { capture, CANON, type CaptureKind } from './capture.js';

// Read a Brain note by title (and optional folder).
registerTool({
  name: 'read_brain_note',
  description:
    "Read a Brain note's full content by title. Use the compact Brain index in your context to find relevant titles, then pull only what you need. The response lists the note's outgoing [[wikilinks]] and its backlinks so you can traverse related notes.",
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Exact note title' },
      folder: { type: 'string', description: 'Optional folder to disambiguate' },
    },
    required: ['title'],
  },
  async execute(input, ctx) {
    const note = await prisma.brainNote.findFirst({
      where: {
        serverId: ctx.serverId,
        title: String(input.title),
        ...(input.folder ? { folder: String(input.folder) } : {}),
      },
    });
    if (!note) return `No note titled "${input.title}" found.`;

    const all = await prisma.brainNote.findMany({
      where: { serverId: ctx.serverId },
      select: { id: true, folder: true, title: true, content: true },
    });
    const path = (folder: string, title: string) => `${folder ? folder + '/' : ''}${title}`;
    const links = outgoingLinks(note, all)
      .map(({ link, resolved }) =>
        resolved ? path(resolved.folder, resolved.title) : `${link.target} (unresolved)`,
      );
    const backlinks = computeBacklinks(note, all).map((n) => path(n.folder, n.title));

    const parts = [`# ${note.title}`, `(folder: ${note.folder || 'root'})`, '', note.content];
    if (links.length) parts.push('', `Links: ${links.join(', ')}`);
    if (backlinks.length) parts.push('', `Backlinks: ${backlinks.join(', ')}`);
    return parts.join('\n');
  },
});

// Write / update a Brain note. Honors the server's write policy: "direct" writes
// immediately; "propose" creates a diff for Commander approval.
registerTool({
  name: 'write_brain_note',
  description:
    'Create or update a shared Brain note. Include a one-line summary for the index. Link notes with [[wikilinks]] — [[Title]], [[Folder/Title]], or [[Title|alias]]. May require Commander approval.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      folder: { type: 'string', description: 'e.g. About, People, Projects, Style' },
      summary: { type: 'string', description: 'One-line summary for the Brain index' },
      content: { type: 'string', description: 'Full markdown content' },
    },
    required: ['title', 'content'],
  },
  summarize: (input) => `Write Brain note "${input.title}"`,
  async execute(input, ctx) {
    const server = await prisma.server.findUnique({ where: { id: ctx.serverId } });
    const settings = (server?.settings ?? {}) as { brainWritePolicy?: string };
    const policy = settings.brainWritePolicy ?? 'propose';

    const title = String(input.title);
    const folder = String(input.folder ?? '');
    const summary = String(input.summary ?? '');
    const content = String(input.content);

    if (policy === 'propose') {
      const existing = await prisma.brainNote.findFirst({
        where: { serverId: ctx.serverId, title, folder },
      });
      const proposal = await prisma.brainProposal.create({
        data: {
          serverId: ctx.serverId,
          noteId: existing?.id,
          folder,
          title,
          summary,
          newContent: content,
          proposedBy: ctx.agent.id,
        },
      });
      bus.emit('proposal.created', { serverId: ctx.serverId, proposal });
      return `Proposed change to Brain note "${title}" — awaiting Commander approval.`;
    }

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
  },
});

// Search the Brain (title/summary/content contains).
registerTool({
  name: 'search_brain',
  description: 'Search shared Brain notes by keyword. Returns matching titles + summaries.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  async execute(input, ctx) {
    const q = String(input.query);
    const notes = await prisma.brainNote.findMany({
      where: {
        serverId: ctx.serverId,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { summary: { contains: q, mode: 'insensitive' } },
          { content: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: { title: true, folder: true, summary: true },
    });
    if (notes.length === 0) return `No Brain notes match "${q}".`;
    return notes.map((n) => `- ${n.folder ? n.folder + '/' : ''}${n.title}: ${n.summary}`).join('\n');
  },
});

// Quickly capture an important fact into the Brain. Lighter than write_brain_note
// — agents call this proactively when they notice durable, important information
// (decisions, preferences, deadlines, key facts). Groups captures by topic under
// an "Inbox" folder so the Brain stays tidy; writes directly (never proposes).
registerTool({
  name: 'flag_important',
  description:
    'Remember one durable thing about the Commander, proactively and without being asked. ' +
    'kind="style" is for HOW they communicate (phrasing, tone, formatting habits, recurring words) — capture this when you notice a pattern, not a one-off. ' +
    'Other kinds: preference (standing likes/dislikes), fact (names, IDs, context), decision, deadline, project. ' +
    'Only things still true next month. Not small talk, not what they asked for right now, not anything already known.',
  input_schema: {
    type: 'object',
    properties: {
      info: { type: 'string', description: 'One sentence, self-contained (it is read months later without this conversation)' },
      kind: {
        type: 'string',
        enum: ['style', 'preference', 'fact', 'decision', 'deadline', 'project'],
        description: 'Which category this belongs to',
      },
    },
    required: ['info', 'kind'],
  },
  summarize: (input) => `Remember (${input.kind}): ${String(input.info).slice(0, 60)}`,
  async execute(input, ctx) {
    const info = String(input.info ?? '').trim();
    if (!info) return 'Nothing to capture.';
    const kind = String(input.kind ?? 'fact') as CaptureKind;
    if (!(kind in CANON)) return `Unknown kind "${kind}". Use one of: ${Object.keys(CANON).join(', ')}.`;
    // Dedup, budget, rotation and the fixed note taxonomy all live in capture().
    const { message } = await capture(kind, info, ctx);
    return message;
  },
});

import { Router } from 'express';
import { z } from 'zod';
import { MemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';
import { bus } from '../realtime/bus.js';
import { invalidateBrainIndex } from '../agents/brainIndex.js';
import { outgoingLinks, computeBacklinks } from '../lib/wikilinks.js';

export const brainRouter = Router({ mergeParams: true });

brainRouter.use(requireAuth);
brainRouter.use(requireServerMember());

// GET /servers/:serverId/brain/notes — index only (no content)
brainRouter.get('/notes', async (req, res, next) => {
  try {
    const notes = await prisma.brainNote.findMany({
      where: { serverId: req.membership!.serverId },
      select: { id: true, folder: true, title: true, summary: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    return res.json({ notes });
  } catch (err) {
    next(err);
  }
});

// GET /servers/:serverId/brain/graph — the whole [[wikilink]] graph (nodes + edges)
brainRouter.get('/graph', async (req, res, next) => {
  try {
    const all = await prisma.brainNote.findMany({
      where: { serverId: req.membership!.serverId },
      select: { id: true, folder: true, title: true, content: true },
    });
    const nodes = all.map((n) => ({ id: n.id, title: n.title, folder: n.folder }));
    const seen = new Set<string>();
    const edges: Array<{ source: string; target: string }> = [];
    for (const n of all) {
      for (const { resolved } of outgoingLinks(n, all)) {
        if (!resolved) continue; // only draw edges that actually resolve
        const key = `${n.id}->${resolved.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: n.id, target: resolved.id });
      }
    }
    return res.json({ nodes, edges });
  } catch (err) {
    next(err);
  }
});

// GET /servers/:serverId/brain/notes/:noteId — full content
brainRouter.get('/notes/:noteId', async (req, res, next) => {
  try {
    const note = await prisma.brainNote.findFirst({
      where: { id: req.params.noteId, serverId: req.membership!.serverId },
    });
    if (!note) return res.status(404).json({ error: 'not found' });

    // Resolve the note's graph edges: outgoing [[wikilinks]] + backlinks.
    const all = await prisma.brainNote.findMany({
      where: { serverId: req.membership!.serverId },
      select: { id: true, folder: true, title: true, content: true },
    });
    const links = outgoingLinks(note, all).map(({ link, resolved }) => ({
      target: link.target,
      label: link.alias ?? link.title,
      noteId: resolved?.id ?? null,
      folder: resolved?.folder ?? link.folder ?? null,
      title: resolved?.title ?? link.title,
    }));
    const backlinks = computeBacklinks(note, all).map((n) => ({ id: n.id, title: n.title, folder: n.folder }));

    return res.json({ note, links, backlinks });
  } catch (err) {
    next(err);
  }
});

const createNoteSchema = z.object({
  folder: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  content: z.string(),
});

// POST /servers/:serverId/brain/notes
brainRouter.post('/notes', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = createNoteSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const note = await prisma.brainNote.create({
      data: {
        serverId: req.membership!.serverId,
        folder: body.data.folder ?? '',
        title: body.data.title,
        summary: body.data.summary ?? '',
        content: body.data.content,
        updatedBy: req.user!.id,
      },
    });

    bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
    return res.status(201).json({ note });
  } catch (err) {
    next(err);
  }
});

const patchNoteSchema = z.object({
  folder: z.string().optional(),
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
});

// PATCH /servers/:serverId/brain/notes/:noteId
brainRouter.patch('/notes/:noteId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const body = patchNoteSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid body' });

    const note = await prisma.brainNote.findFirst({
      where: { id: req.params.noteId, serverId: req.membership!.serverId },
    });
    if (!note) return res.status(404).json({ error: 'not found' });

    const updated = await prisma.brainNote.update({
      where: { id: note.id },
      data: { ...body.data, updatedBy: req.user!.id },
    });

    bus.emit('brain.updated', { serverId: req.membership!.serverId, note: updated });
    return res.json({ note: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /servers/:serverId/brain/notes/:noteId
brainRouter.delete('/notes/:noteId', requireServerMember(MemberRole.ADMIN), async (req, res, next) => {
  try {
    const note = await prisma.brainNote.findFirst({
      where: { id: req.params.noteId, serverId: req.membership!.serverId },
    });
    if (!note) return res.status(404).json({ error: 'not found' });

    await prisma.brainNote.delete({ where: { id: note.id } });
    invalidateBrainIndex(req.membership!.serverId);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Proposals ─────────────────────────────────────────────────────────────────

// GET /servers/:serverId/brain/proposals?status=PENDING
brainRouter.get('/proposals', async (req, res, next) => {
  try {
    const status = (req.query.status as string) || 'PENDING';
    const proposals = await prisma.brainProposal.findMany({
      where: {
        serverId: req.membership!.serverId,
        ...(status && { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ proposals });
  } catch (err) {
    next(err);
  }
});

// POST /servers/:serverId/brain/proposals/:id/approve
brainRouter.post(
  '/proposals/:id/approve',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      const proposal = await prisma.brainProposal.findFirst({
        where: { id: req.params.id, serverId: req.membership!.serverId },
      });
      if (!proposal) return res.status(404).json({ error: 'not found' });
      if (proposal.status !== 'PENDING') return res.status(409).json({ error: 'not pending' });

      // Upsert the brain note from the proposal
      let note;
      if (proposal.noteId) {
        note = await prisma.brainNote.update({
          where: { id: proposal.noteId },
          data: {
            folder: proposal.folder,
            title: proposal.title,
            summary: proposal.summary,
            content: proposal.newContent,
            updatedBy: proposal.proposedBy,
          },
        });
      } else {
        note = await prisma.brainNote.create({
          data: {
            serverId: req.membership!.serverId,
            folder: proposal.folder,
            title: proposal.title,
            summary: proposal.summary,
            content: proposal.newContent,
            updatedBy: proposal.proposedBy,
          },
        });
      }

      await prisma.brainProposal.update({
        where: { id: proposal.id },
        data: { status: 'APPROVED', noteId: note.id },
      });

      bus.emit('brain.updated', { serverId: req.membership!.serverId, note });
      return res.json({ note });
    } catch (err) {
      next(err);
    }
  },
);

// POST /servers/:serverId/brain/proposals/:id/reject
brainRouter.post(
  '/proposals/:id/reject',
  requireServerMember(MemberRole.ADMIN),
  async (req, res, next) => {
    try {
      const proposal = await prisma.brainProposal.findFirst({
        where: { id: req.params.id, serverId: req.membership!.serverId },
      });
      if (!proposal) return res.status(404).json({ error: 'not found' });

      await prisma.brainProposal.update({
        where: { id: proposal.id },
        data: { status: 'REJECTED' },
      });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
